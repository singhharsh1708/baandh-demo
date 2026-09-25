var PRESETS = {
  barpeta_2022: {
    bbox: [90.95, 26.28, 91.05, 26.36],
    before: ['2022-04-25', '2022-05-15'],
    after: ['2022-06-14', '2022-06-19'],
    pass_direction: 'ASCENDING',
    relative_orbit: 41,
    reservoir_bbox: null
  },
  annamayya_2021: {
    bbox: [79.00, 14.19, 79.22, 14.36],
    before: ['2021-11-07', '2021-11-17'],
    after: ['2021-11-19', '2021-11-29'],
    pass_direction: 'DESCENDING',
    relative_orbit: 92,
    reservoir_bbox: [78.99, 14.12, 79.05, 14.225]
  }
};

var CASE = 'barpeta_2022';
var cfg = PRESETS[CASE];

var aoi = (typeof geometry !== 'undefined') ? geometry : ee.Geometry.Rectangle(cfg.bbox);

var polarization = 'VH';
var difference_threshold = 1.25;
var smoothing_radius = 50;
var seasonality_months = 10;
var min_connected = 8;
var max_slope_deg = 5;
var water_threshold_db = -18;
var export_folder = 'baandh_gee';
var model_asset = null;

var s1 = ee.ImageCollection('COPERNICUS/S1_GRD')
  .filter(ee.Filter.eq('instrumentMode', 'IW'))
  .filter(ee.Filter.eq('orbitProperties_pass', cfg.pass_direction))
  .filter(ee.Filter.eq('resolution_meters', 10));
if (cfg.relative_orbit !== null) {
  s1 = s1.filter(ee.Filter.eq('relativeOrbitNumber_start', cfg.relative_orbit));
}

var collection = s1
  .filter(ee.Filter.listContains('transmitterReceiverPolarisation', polarization))
  .filterBounds(aoi)
  .select(polarization);

var before_collection = collection.filterDate(cfg.before[0], cfg.before[1]);
var after_collection = collection.filterDate(cfg.after[0], cfg.after[1]);
print('Case', CASE);
print('Before scenes', before_collection.aggregate_array('system:index'));
print('After scenes', after_collection.aggregate_array('system:index'));

var before = before_collection.mosaic().clip(aoi);
var after = after_collection.mosaic().clip(aoi);

var before_filtered = before.focal_mean(smoothing_radius, 'circle', 'meters');
var after_filtered = after.focal_mean(smoothing_radius, 'circle', 'meters');

var difference = after_filtered.divide(before_filtered);
var difference_binary = difference.gt(difference_threshold);

var swater = ee.Image('JRC/GSW1_4/GlobalSurfaceWater').select('seasonality');
var swater_mask = swater.gte(seasonality_months).updateMask(swater.gte(seasonality_months));
var flooded_mask = difference_binary.where(swater_mask, 0);
var flooded = flooded_mask.updateMask(flooded_mask);

var connections = flooded.connectedPixelCount();
flooded = flooded.updateMask(connections.gte(min_connected));

var dem = ee.Image('WWF/HydroSHEDS/03VFDEM');
var slope = ee.Algorithms.Terrain(dem).select('slope');
flooded = flooded.updateMask(slope.lt(max_slope_deg)).rename('flooded');

var area_ha = function (img, region) {
  return img.multiply(ee.Image.pixelArea())
    .reduceRegion({reducer: ee.Reducer.sum(), geometry: region, scale: 10, maxPixels: 1e10, bestEffort: true})
    .getNumber(img.bandNames().get(0)).divide(10000).round();
};

print('Flood extent (ha)', area_ha(flooded, aoi));

var population = ee.Image('JRC/GHSL/P2023A/GHS_POP/2020').select('population_count');
var flooded_pop_grid = flooded.unmask(0).reproject({crs: population.projection()}).gt(0);
var exposed_pop = population.updateMask(flooded_pop_grid).reduceRegion({
  reducer: ee.Reducer.sum(), geometry: aoi, scale: 100, maxPixels: 1e10
}).getNumber('population_count').round();
print('Exposed population (GHS-POP 2020, 100 m)', exposed_pop);

var worldcover = ee.ImageCollection('ESA/WorldCover/v200').first().select('Map');
print('Flooded cropland (ha, WorldCover 40)', area_ha(flooded.updateMask(worldcover.eq(40)), aoi));
print('Flooded built-up (ha, WorldCover 50)', area_ha(flooded.updateMask(worldcover.eq(50)), aoi));

Map.centerObject(aoi, 12);
Map.addLayer(before_filtered, {min: -25, max: 0}, 'Before flood', false);
Map.addLayer(after_filtered, {min: -25, max: 0}, 'After flood', false);
Map.addLayer(difference, {min: 0, max: 2}, 'After / before ratio', false);
Map.addLayer(swater_mask, {palette: ['1baf7a']}, 'Permanent water (GSW seasonality >= 10)', false);
Map.addLayer(flooded, {palette: ['2a78d6']}, 'Flooded areas');

var flood_vectors = flooded.reduceToVectors({
  geometry: aoi, scale: 10, geometryType: 'polygon', eightConnected: false,
  labelProperty: 'flooded', bestEffort: true, maxPixels: 1e10
});

Export.image.toDrive({image: flooded.unmask(0).toByte(), description: CASE + '_flood_raster',
  folder: export_folder, fileNamePrefix: CASE + '_flood', region: aoi, scale: 10, maxPixels: 1e10});
Export.table.toDrive({collection: flood_vectors, description: CASE + '_flood_shp',
  folder: export_folder, fileNamePrefix: CASE + '_flood', fileFormat: 'SHP'});
Export.table.toDrive({collection: flood_vectors, description: CASE + '_flood_kml',
  folder: export_folder, fileNamePrefix: CASE + '_flood', fileFormat: 'KML'});

if (cfg.reservoir_bbox !== null) {
  var reservoir_box = ee.Geometry.Rectangle(cfg.reservoir_bbox);
  var gsw_extent = ee.Image('JRC/GSW1_4/GlobalSurfaceWater').select('max_extent').clip(reservoir_box);
  var footprint = gsw_extent.eq(1).focalMax(30, 'square', 'meters').selfMask();
  var vv = s1.filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV'))
    .filterBounds(reservoir_box).filterDate(cfg.before[0], cfg.after[1]).select('VV');
  var water_area = vv.map(function (img) {
    var water = img.focal_mean(smoothing_radius, 'circle', 'meters').lt(water_threshold_db)
      .updateMask(footprint).selfMask().rename('water');
    return ee.Feature(null, {
      date: img.date().format('YYYY-MM-dd'),
      water_km2: area_ha(water, reservoir_box).divide(100)
    });
  });
  print('Reservoir water area by date (VV < ' + water_threshold_db + ' dB)', water_area);
  Export.table.toDrive({collection: water_area, description: CASE + '_reservoir_water',
    folder: export_folder, fileNamePrefix: CASE + '_reservoir_water', fileFormat: 'CSV'});
}

if (model_asset !== null) {
  var modelled = ee.Image(model_asset).gt(0).unmask(0);
  var observed = flooded.unmask(0).gt(0);
  var counts = ee.Image.cat([
    modelled.and(observed).rename('hits'),
    modelled.not().and(observed).rename('misses'),
    modelled.and(observed.not()).rename('false_alarms')
  ]).reduceRegion({reducer: ee.Reducer.sum(), geometry: aoi, scale: 10, maxPixels: 1e10, bestEffort: true});
  var hits = counts.getNumber('hits');
  var csi = hits.divide(hits.add(counts.getNumber('misses')).add(counts.getNumber('false_alarms')));
  print('Model vs Sentinel-1 critical success index', csi);
}
