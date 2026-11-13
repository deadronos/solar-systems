import type { BodyDefinition } from './types.ts';

/**
 * Sun and the eight major planets.
 * Orbits: JPL approximate Keplerian elements (Standish, Tables 2a/2b, 3000 BC–3000 AD).
 * https://ssd.jpl.nasa.gov/planets/approx_pos.html
 * Radii / flattening: IAU WGCCRE 2015 & NASA fact sheets.
 * Poles: IAU WGCCRE 2015 (positive pole, see RotationModel).
 */
export const SUN: BodyDefinition = {
  id: 'sun',
  name: 'Sun',
  kind: 'star',
  parentId: null,
  radiusKm: 695_700,
  gm: 1.327_124_400_18e11,
  rotation: { poleRaDeg: 286.13, poleDecDeg: 63.87, periodHours: 609.12, W0Deg: 84.176 },
};

export const PLANETS: readonly BodyDefinition[] = [
  {
    id: 'mercury',
    name: 'Mercury',
    kind: 'planet',
    parentId: 'sun',
    radiusKm: 2_439.7,
    gm: 22_031.86,
    orbit: {
      kind: 'jplApprox',
      elements: [0.38709843, 0.20563661, 7.00559432, 252.25166724, 77.45771895, 48.33961819],
      rates: [0.0, 0.00002123, -0.00590158, 149472.67486623, 0.15940013, -0.12214182],
    },
    rotation: { poleRaDeg: 281.0103, poleDecDeg: 61.4155, periodHours: 1_407.6, W0Deg: 329.5988 },
  },
  {
    id: 'venus',
    name: 'Venus',
    kind: 'planet',
    parentId: 'sun',
    radiusKm: 6_051.8,
    gm: 324_858.59,
    orbit: {
      kind: 'jplApprox',
      elements: [0.72332102, 0.00676399, 3.39777545, 181.9797085, 131.76755713, 76.67261496],
      rates: [-0.00000026, -0.00005107, 0.00043494, 58517.8156026, 0.05679648, -0.27274174],
    },
    // Retrograde: positive pole is opposite the IAU north pole (272.76, 67.16).
    rotation: { poleRaDeg: 92.76, poleDecDeg: -67.16, periodHours: 5_832.6, W0Deg: 160.2 },
  },
  {
    id: 'earth',
    name: 'Earth',
    kind: 'planet',
    parentId: 'sun',
    radiusKm: 6_371.0,
    flattening: 0.003_352_8,
    gm: 398_600.435,
    // Earth–Moon barycenter elements; Earth sits ~4,670 km from it, opposite the Moon.
    barycentricPartner: 'moon',
    orbit: {
      kind: 'jplApprox',
      elements: [1.00000018, 0.01673163, -0.00054346, 100.46691572, 102.93005885, -5.11260389],
      rates: [-0.00000003, -0.00003661, -0.01337178, 35999.37306329, 0.3179526, -0.24123856],
    },
    rotation: { poleRaDeg: 0, poleDecDeg: 90, periodHours: 23.934_469_6, W0Deg: 190.147 },
  },
  {
    id: 'mars',
    name: 'Mars',
    kind: 'planet',
    parentId: 'sun',
    radiusKm: 3_389.5,
    flattening: 0.005_89,
    gm: 42_828.37,
    orbit: {
      kind: 'jplApprox',
      elements: [1.52371243, 0.09336511, 1.85181869, -4.56813164, -23.91744784, 49.71320984],
      rates: [0.00000097, 0.00009149, -0.00724757, 19140.29934243, 0.45223625, -0.26852431],
    },
    rotation: {
      poleRaDeg: 317.681_43,
      poleDecDeg: 52.886_5,
      periodHours: 24.622_962,
      W0Deg: 176.63,
    },
  },
  {
    id: 'jupiter',
    name: 'Jupiter',
    kind: 'planet',
    parentId: 'sun',
    radiusKm: 69_911,
    flattening: 0.064_87,
    gm: 126_686_534,
    orbit: {
      kind: 'jplApprox',
      elements: [5.20248019, 0.0485359, 1.29861416, 34.33479152, 14.27495244, 100.29282654],
      rates: [-0.00002864, 0.00018026, -0.00322699, 3034.90371757, 0.18199196, 0.13024619],
      meanAnomalyCorrection: [-0.00012452, 0.0606406, -0.35635438, 38.35125],
    },
    rotation: {
      poleRaDeg: 268.056_595,
      poleDecDeg: 64.495_303,
      periodHours: 9.925_5,
      W0Deg: 284.95,
    },
  },
  {
    id: 'saturn',
    name: 'Saturn',
    kind: 'planet',
    parentId: 'sun',
    radiusKm: 58_232,
    flattening: 0.097_96,
    gm: 37_931_187,
    orbit: {
      kind: 'jplApprox',
      elements: [9.54149883, 0.05550825, 2.49424102, 50.07571329, 92.86136063, 113.63998702],
      rates: [-0.00003065, -0.00032044, 0.00451969, 1222.11494724, 0.54179478, -0.25015002],
      meanAnomalyCorrection: [0.00025899, -0.13434469, 0.87320147, 38.35125],
    },
    rotation: { poleRaDeg: 40.589, poleDecDeg: 83.537, periodHours: 10.656_222, W0Deg: 38.9 },
  },
  {
    id: 'uranus',
    name: 'Uranus',
    kind: 'planet',
    parentId: 'sun',
    radiusKm: 25_362,
    flattening: 0.022_93,
    gm: 5_793_939,
    orbit: {
      kind: 'jplApprox',
      elements: [19.18797948, 0.0468574, 0.77298127, 314.20276625, 172.43404441, 73.96250215],
      rates: [-0.00020455, -0.0000155, -0.00180155, 428.49512595, 0.09266985, 0.05739699],
      meanAnomalyCorrection: [0.00058331, -0.97731848, 0.17689245, 7.67025],
    },
    // Retrograde: positive pole is opposite the IAU north pole (257.311, −15.175).
    rotation: { poleRaDeg: 77.311, poleDecDeg: 15.175, periodHours: 17.24, W0Deg: 203.81 },
  },
  {
    id: 'neptune',
    name: 'Neptune',
    kind: 'planet',
    parentId: 'sun',
    radiusKm: 24_622,
    flattening: 0.017_08,
    gm: 6_836_529,
    orbit: {
      kind: 'jplApprox',
      elements: [30.06952752, 0.00895439, 1.7700552, 304.22289287, 46.68158724, 131.78635853],
      rates: [0.00006447, 0.00000818, 0.000224, 218.46515314, 0.01009938, -0.00606302],
      meanAnomalyCorrection: [-0.00041348, 0.68346318, -0.10162547, 7.67025],
    },
    rotation: { poleRaDeg: 299.36, poleDecDeg: 43.46, periodHours: 16.11, W0Deg: 249.978 },
  },
];
