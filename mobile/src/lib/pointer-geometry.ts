export type PointerSurfaceSize = { width: number; height: number };
export type PointerPoint = { id: number; x: number; y: number };

export type PointerGeometry =
  | { kind: 'legacy-aspect-fit'; widthMm: number; heightMm: number }
  | { kind: 'square-centered'; sideMm: number; gainMmPerPoint: number };

export type PointerGeometrySelection = {
  profileId: string;
  geometryEpoch: number;
  geometry: PointerGeometry;
};

export const LEGACY_POINTER_GEOMETRY: PointerGeometry = {
  kind: 'legacy-aspect-fit', widthMm: 100, heightMm: 70,
};

// Candidate only. A negotiated peer must opt into this profile before a
// provider changes its physical geometry; legacy peers continue using 100x70.
export const SQUARE_POINTER_GEOMETRY: PointerGeometry = {
  kind: 'square-centered', sideMm: 100, gainMmPerPoint: 100 / 844,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const finitePositiveNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * Read only the server-confirmed profile. `supportedProfiles` is an
 * advertisement; it never selects a mapper. A legacy or malformed/partial
 * advertisement therefore remains on the byte-compatible fallback until the
 * core capability parser supplies an applied profile and epoch.
 */
export function selectPointerGeometry(capabilities: unknown): PointerGeometrySelection {
  if (!isRecord(capabilities) || !isRecord(capabilities.input)
    || !isRecord(capabilities.input.pointerGeometry)) {
    return { profileId: 'legacy-100x70', geometryEpoch: 0, geometry: LEGACY_POINTER_GEOMETRY };
  }
  const advertisement = capabilities.input.pointerGeometry;
  if (advertisement.version !== 1 || !Array.isArray(advertisement.supportedProfiles)
    || !isRecord(advertisement.applied)
    || typeof advertisement.applied.id !== 'string'
    || !Number.isSafeInteger(advertisement.applied.geometryEpoch)
    || Number(advertisement.applied.geometryEpoch) < 1) {
    return { profileId: 'legacy-100x70', geometryEpoch: 0, geometry: LEGACY_POINTER_GEOMETRY };
  }
  const appliedID = advertisement.applied.id;
  const appliedEpoch = Number(advertisement.applied.geometryEpoch);
  const profile = advertisement.supportedProfiles.find(candidate =>
    isRecord(candidate) && candidate.id === appliedID);
  if (!isRecord(profile)) {
    return { profileId: 'legacy-100x70', geometryEpoch: appliedEpoch, geometry: LEGACY_POINTER_GEOMETRY };
  }
  if (profile.id === 'legacy-100x70') {
    if (profile.kind !== 'legacy-aspect-fit' || profile.widthMm !== 100 || profile.heightMm !== 70
      || profile.sideMm !== undefined || profile.gainMmPerPoint !== undefined
      || profile.gainSource !== undefined || profile.gainMinMmPerPoint !== undefined
      || profile.gainMaxMmPerPoint !== undefined) {
      return { profileId: 'legacy-100x70', geometryEpoch: appliedEpoch, geometry: LEGACY_POINTER_GEOMETRY };
    }
    return { profileId: 'legacy-100x70', geometryEpoch: appliedEpoch, geometry: LEGACY_POINTER_GEOMETRY };
  }
  const sideMm = profile.sideMm;
  const gainMmPerPoint = profile.gainMmPerPoint;
  const gainMinMmPerPoint = profile.gainMinMmPerPoint;
  const gainMaxMmPerPoint = profile.gainMaxMmPerPoint;
  if (profile.id !== 'square-centered' || profile.kind !== 'square-centered'
    || !finitePositiveNumber(sideMm) || sideMm < 50 || sideMm > 200
    || !finitePositiveNumber(gainMmPerPoint) || gainMmPerPoint < .05 || gainMmPerPoint > .25
    || profile.gainSource !== 'calibrated'
    || !finitePositiveNumber(gainMinMmPerPoint) || gainMinMmPerPoint < .05 || gainMinMmPerPoint > .25
    || !finitePositiveNumber(gainMaxMmPerPoint) || gainMaxMmPerPoint < .05 || gainMaxMmPerPoint > .25
    || gainMmPerPoint < gainMinMmPerPoint
    || gainMmPerPoint > gainMaxMmPerPoint) {
    return { profileId: 'legacy-100x70', geometryEpoch: appliedEpoch, geometry: LEGACY_POINTER_GEOMETRY };
  }
  return {
    profileId: profile.id,
    geometryEpoch: appliedEpoch,
    geometry: { kind: 'square-centered', sideMm, gainMmPerPoint },
  };
}

function finitePositive(value: number, fallback: number) {
  'worklet';
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clampUnit(value: number) {
  'worklet';
  return Math.max(0, Math.min(1, value));
}

function coordinate(value: number) {
  'worklet';
  return Number.isFinite(value) ? value : 0;
}

/**
 * Keep the mapping in Float64 until the daemon serializes a uinput axis.
 * The square candidate preserves screen axes and leaves deliberate centered
 * margins; it does not clamp those margins to disguise an invalid profile.
 */
export function mapPointerToContact(
  point: PointerPoint,
  surface: PointerSurfaceSize,
  geometry: PointerGeometry = LEGACY_POINTER_GEOMETRY,
): PointerPoint {
  'worklet';
  const width = finitePositive(surface.width, 1);
  const height = finitePositive(surface.height, 1);
  const x = coordinate(point.x);
  const y = coordinate(point.y);
  if (geometry.kind === 'square-centered'
    && Number.isFinite(geometry.sideMm) && geometry.sideMm > 0
    && Number.isFinite(geometry.gainMmPerPoint) && geometry.gainMmPerPoint > 0) {
    return {
      id: point.id,
      x: clampUnit((geometry.sideMm - geometry.gainMmPerPoint * width) / (2 * geometry.sideMm)
        + geometry.gainMmPerPoint * x / geometry.sideMm),
      y: clampUnit((geometry.sideMm - geometry.gainMmPerPoint * height) / (2 * geometry.sideMm)
        + geometry.gainMmPerPoint * y / geometry.sideMm),
    };
  }
  const legacy: Extract<PointerGeometry, { kind: 'legacy-aspect-fit' }> = geometry.kind === 'legacy-aspect-fit'
    ? geometry : { kind: 'legacy-aspect-fit', widthMm: 100, heightMm: 70 };
  const scale = Math.min(legacy.widthMm / width, legacy.heightMm / height);
  const offsetX = (legacy.widthMm - width * scale) / 2;
  const offsetY = (legacy.heightMm - height * scale) / 2;
  return {
    id: point.id,
    x: Math.max(0, Math.min(1, (offsetX + x * scale) / legacy.widthMm)),
    y: Math.max(0, Math.min(1, (offsetY + y * scale) / legacy.heightMm)),
  };
}

export function mapPointerSnapshot(
  points: readonly PointerPoint[],
  surface: PointerSurfaceSize,
  geometry: PointerGeometry = LEGACY_POINTER_GEOMETRY,
): PointerPoint[] {
  'worklet';
  return points.map(point => mapPointerToContact(point, surface, geometry))
    .sort((left, right) => left.id - right.id);
}

// The calibrated mobile mapper keeps millimeters per logical point invariant
// across rotation. The host remains the only acceleration stage.
export function mapCalibratedPointerSnapshot(points: readonly PointerPoint[], surface: PointerSurfaceSize, geometry: PointerGeometry, gain: number): PointerPoint[] {
 'worklet';
 const width=finitePositive(surface.width,1),height=finitePositive(surface.height,1);
 const w=geometry.kind==='square-centered'?geometry.sideMm:geometry.widthMm;
 const h=geometry.kind==='square-centered'?geometry.sideMm:geometry.heightMm;
 const scale=(geometry.kind==='square-centered'?geometry.gainMmPerPoint:Math.min(w,h)/Math.max(width,height))*Math.max(.5,Math.min(2,gain));
 return points.map(p=>({id:p.id,x:clampUnit(.5+(coordinate(p.x)-width/2)*scale/w),y:clampUnit(.5+(coordinate(p.y)-height/2)*scale/h)})).sort((a,b)=>a.id-b.id);
}
