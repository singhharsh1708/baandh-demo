# BaandhRakshak demo

Dam-break inundation modelling prototype. Smart India Hackathon 2026, problem statement SIH26161 (Dam Break Inundation Modelling Using Hydrodynamic Modelling of any River, NTRO).

- Live demo: https://singhharsh1708.github.io/baandh-demo/
- Demo video: [baandh_demo.mp4](baandh_demo.mp4)

This repository holds only the built dashboard and the video. The test case is the Annamayya dam breach on the Cheyyeru river, Andhra Pradesh, 19 Nov 2021. The flood runs in Delft3D FM and in shallow-water SPH, and the breach itself in DualSPHysics.

Caveats: 30 m DEM; the breach size comes from the Froehlich (2008) regression; tailwater is ignored, so the peak may be high; no satellite observed this flood, so the check is against the villages named in reports. The Method notes are in the dashboard.
