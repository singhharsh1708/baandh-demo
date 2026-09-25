import argparse

import ee

PRESETS = {
    "barpeta_2022": dict(
        bbox="90.95,26.28,91.05,26.36", before="2022-04-25/2022-05-15", after="2022-06-14/2022-06-19",
        pass_direction="ASCENDING", relative_orbit=41, reservoir_bbox=None,
    ),
    "annamayya_2021": dict(
        bbox="79.00,14.19,79.22,14.36", before="2021-11-07/2021-11-17", after="2021-11-19/2021-11-29",
        pass_direction="DESCENDING", relative_orbit=92, reservoir_bbox="78.99,14.12,79.05,14.225",
    ),
}


def parse():
    p = argparse.ArgumentParser()
    p.add_argument("--project", required=True)
    p.add_argument("--case", choices=sorted(PRESETS), default="barpeta_2022")
    p.add_argument("--bbox")
    p.add_argument("--before")
    p.add_argument("--after")
    p.add_argument("--pass-direction")
    p.add_argument("--relative-orbit", type=int)
    p.add_argument("--reservoir-bbox")
    p.add_argument("--pol", default="VH")
    p.add_argument("--threshold", type=float, default=1.25)
    p.add_argument("--smoothing-m", type=float, default=50)
    p.add_argument("--seasonality-months", type=int, default=10)
    p.add_argument("--min-connected", type=int, default=8)
    p.add_argument("--max-slope-deg", type=float, default=5)
    p.add_argument("--water-threshold-db", type=float, default=-18)
    p.add_argument("--model-asset")
    p.add_argument("--export", action="store_true")
    p.add_argument("--folder", default="baandh_gee")
    a = p.parse_args()
    for k, v in PRESETS[a.case].items():
        if getattr(a, k) is None:
            setattr(a, k, v)
    return a


def rect(bbox):
    return ee.Geometry.Rectangle([float(v) for v in bbox.split(",")])


def s1(pass_direction, relative_orbit):
    col = (
        ee.ImageCollection("COPERNICUS/S1_GRD")
        .filter(ee.Filter.eq("instrumentMode", "IW"))
        .filter(ee.Filter.eq("orbitProperties_pass", pass_direction))
        .filter(ee.Filter.eq("resolution_meters", 10))
    )
    if relative_orbit is not None:
        col = col.filter(ee.Filter.eq("relativeOrbitNumber_start", relative_orbit))
    return col


def flood_extent(a, aoi):
    col = s1(a.pass_direction, a.relative_orbit).filter(
        ee.Filter.listContains("transmitterReceiverPolarisation", a.pol)).filterBounds(aoi).select(a.pol)
    before_col = col.filterDate(*a.before.split("/"))
    after_col = col.filterDate(*a.after.split("/"))
    before_f = before_col.mosaic().clip(aoi).focal_mean(a.smoothing_m, "circle", "meters")
    after_f = after_col.mosaic().clip(aoi).focal_mean(a.smoothing_m, "circle", "meters")
    binary = after_f.divide(before_f).gt(a.threshold)
    swater = ee.Image("JRC/GSW1_4/GlobalSurfaceWater").select("seasonality")
    flooded = binary.where(swater.gte(a.seasonality_months).selfMask(), 0)
    flooded = flooded.updateMask(flooded)
    flooded = flooded.updateMask(flooded.connectedPixelCount().gte(a.min_connected))
    slope = ee.Algorithms.Terrain(ee.Image("WWF/HydroSHEDS/03VFDEM")).select("slope")
    return flooded.updateMask(slope.lt(a.max_slope_deg)).rename("flooded"), before_col, after_col


def area_ha(img, region, band):
    s = img.multiply(ee.Image.pixelArea()).reduceRegion(
        reducer=ee.Reducer.sum(), geometry=region, scale=10, maxPixels=1e10, bestEffort=True
    )
    return s.getNumber(band).divide(10000).round()


def reservoir_water(a):
    box = rect(a.reservoir_bbox)
    footprint = (ee.Image("JRC/GSW1_4/GlobalSurfaceWater").select("max_extent").clip(box)
                 .eq(1).focalMax(30, "square", "meters").selfMask())
    vv = (s1(a.pass_direction, a.relative_orbit)
          .filter(ee.Filter.listContains("transmitterReceiverPolarisation", "VV"))
          .filterBounds(box).filterDate(a.before.split("/")[0], a.after.split("/")[1]).select("VV"))

    def one(img):
        water = (img.focal_mean(a.smoothing_m, "circle", "meters").lt(a.water_threshold_db)
                 .updateMask(footprint).selfMask().rename("water"))
        return ee.Feature(None, {"date": img.date().format("YYYY-MM-dd"),
                                 "water_km2": area_ha(water, box, "water").divide(100)})

    return ee.FeatureCollection(vv.map(one))


def main():
    a = parse()
    ee.Initialize(project=a.project)
    aoi = rect(a.bbox)
    flooded, before_col, after_col = flood_extent(a, aoi)

    pop = ee.Image("JRC/GHSL/P2023A/GHS_POP/2020").select("population_count")
    exposed = pop.updateMask(flooded.unmask(0).reproject(crs=pop.projection()).gt(0)).reduceRegion(
        reducer=ee.Reducer.sum(), geometry=aoi, scale=100, maxPixels=1e10
    ).getNumber("population_count").round()
    wc = ee.ImageCollection("ESA/WorldCover/v200").first().select("Map")

    out = ee.Dictionary({
        "before_scenes": before_col.aggregate_array("system:index"),
        "after_scenes": after_col.aggregate_array("system:index"),
        "flood_area_ha": area_ha(flooded, aoi, "flooded"),
        "exposed_population_ghs_pop_2020": exposed,
        "flooded_cropland_ha": area_ha(flooded.updateMask(wc.eq(40)), aoi, "flooded"),
        "flooded_builtup_ha": area_ha(flooded.updateMask(wc.eq(50)), aoi, "flooded"),
    })

    if a.model_asset:
        modelled = ee.Image(a.model_asset).gt(0).unmask(0)
        observed = flooded.unmask(0).gt(0)
        c = ee.Image.cat([
            modelled.And(observed).rename("hits"),
            modelled.Not().And(observed).rename("misses"),
            modelled.And(observed.Not()).rename("false_alarms"),
        ]).reduceRegion(reducer=ee.Reducer.sum(), geometry=aoi, scale=10, maxPixels=1e10, bestEffort=True)
        hits = c.getNumber("hits")
        out = out.set("csi_model_vs_s1", hits.divide(hits.add(c.getNumber("misses")).add(c.getNumber("false_alarms"))))

    for k, v in out.getInfo().items():
        print(k, v)

    water = reservoir_water(a) if a.reservoir_bbox else None
    if water is not None:
        for f in water.getInfo()["features"]:
            print("reservoir", f["properties"]["date"], f["properties"]["water_km2"], "km2")

    if a.export:
        vectors = flooded.reduceToVectors(
            geometry=aoi, scale=10, geometryType="polygon", eightConnected=False,
            labelProperty="flooded", bestEffort=True, maxPixels=1e10,
        )
        prefix = f"{a.case}_flood"
        tasks = [
            ee.batch.Export.image.toDrive(image=flooded.unmask(0).toByte(), description=f"{prefix}_raster",
                                          folder=a.folder, fileNamePrefix=prefix, region=aoi, scale=10,
                                          maxPixels=1e10),
            ee.batch.Export.table.toDrive(collection=vectors, description=f"{prefix}_shp", folder=a.folder,
                                          fileNamePrefix=prefix, fileFormat="SHP"),
            ee.batch.Export.table.toDrive(collection=vectors, description=f"{prefix}_kml", folder=a.folder,
                                          fileNamePrefix=prefix, fileFormat="KML"),
        ]
        if water is not None:
            tasks.append(ee.batch.Export.table.toDrive(collection=water, description=f"{a.case}_reservoir_water",
                                                       folder=a.folder, fileNamePrefix=f"{a.case}_reservoir_water",
                                                       fileFormat="CSV"))
        for t in tasks:
            t.start()
            print("started", t.id)


if __name__ == "__main__":
    main()
