/**
 * The 3D twin scene (docs/digital-twin-plan.md §9): a table plane, one parametric prop per recognised
 * object at the solver's position, painted with a thermal frame's temperatures — the analysed frame,
 * or whichever frame the player is on when the twin follows the playhead (§11). Lives in the lazy
 * three.js chunk (loaded on first open of the tab), like surface3dScene.
 *
 * Camera: starts exactly where the solver says the phone was (so the first view matches the photo) and
 * orbits from there; "Photo view" snaps back to it.
 *
 * Painting per frame is cheap — a few thousand vertex projections per prop, a few milliseconds in all
 * with the frame alignment and display map — and the colour attribute is allocated once per prop and
 * rewritten in place, so following playback at 5 fps stays well inside the frame budget.
 */
import { useEffect, useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { Html, OrbitControls, PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';
import { STREET_VIEW_VFOV } from '../../../utils/streetViewPano';
import type { PlacedObject, TwinLayout } from '../../../utils/twinSolver';
import { projectVertexTemps, type ThermalSource } from '../../../utils/twinThermal';
import { paletteHexAt } from '../../../utils/palette';
import { temp01ToRgb } from '../../../utils/colormap';
import { displayTemp, temperatureSymbol } from '../../../utils/helpers';
import { TemperatureUnit } from '../../../types';
import { buildProp, kindLabel } from './props';

export type TwinViewMode = 'realistic' | 'thermal' | 'blended';

interface Props {
  layout: TwinLayout;
  thermal: ThermalSource | null;
  palette: string | null;
  mode: TwinViewMode;
  measuredOnly: boolean;
  showLabels: boolean;
  unit: TemperatureUnit;
  /** Bump to snap the camera back to the photographed viewpoint. */
  resetNonce: number;
}

const GRAY = 0.55;

/** 256-entry RGB lookup for the experiment's palette (the same ramp as the 2D frames), or the generic
 *  blue→red ramp when the palette is unknown. */
function useColorLut(palette: string | null): Float32Array {
  return useMemo(() => {
    const lut = new Float32Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      const hex = palette ? paletteHexAt(palette, t) : null;
      let rgb: [number, number, number];
      if (hex) {
        const c = new THREE.Color(hex);
        rgb = [c.r, c.g, c.b];
      } else rgb = temp01ToRgb(t);
      lut[i * 3] = rgb[0];
      lut[i * 3 + 1] = rgb[1];
      lut[i * 3 + 2] = rgb[2];
    }
    return lut;
  }, [palette]);
}

const labelStyle: React.CSSProperties = {
  background: 'rgba(20, 24, 30, 0.78)',
  color: '#fff',
  fontSize: 11,
  lineHeight: 1.3,
  padding: '2px 6px',
  borderRadius: 4,
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
  userSelect: 'none',
};

interface PropMeshProps {
  object: PlacedObject;
  layout: TwinLayout;
  thermal: ThermalSource | null;
  lut: Float32Array;
  mode: TwinViewMode;
  measuredOnly: boolean;
  showLabels: boolean;
  unit: TemperatureUnit;
}

const PropMesh = ({ object, layout, thermal, lut, mode, measuredOnly, showLabels, unit }: PropMeshProps) => {
  const parts = useMemo(() => buildProp(object), [object]);
  // One colour attribute per prop, allocated with the geometry and rewritten in place per frame.
  const colorAttr = useMemo(() => {
    const count = parts.body.getAttribute('position')?.count ?? 0;
    const attr = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    parts.body.setAttribute('color', attr);
    return attr;
  }, [parts]);
  useEffect(
    () => () => {
      parts.body.dispose();
      parts.liquid?.dispose();
      parts.extras.forEach((e) => e.geometry.dispose());
    },
    [parts],
  );

  // Temperatures per body vertex, from the current thermal frame.
  const painted = useMemo(() => {
    if (!thermal) return null;
    const pos = parts.body.getAttribute('position');
    const nor = parts.body.getAttribute('normal');
    if (!pos || !nor) return null;
    return projectVertexTemps(
      pos.array as ArrayLike<number>,
      nor.array as ArrayLike<number>,
      {
        position: object.position,
        yawRad: object.yawRad,
        tiltRad: object.tiltRad,
        tiltAxis: layout.viewDir,
        bbox: object.bbox,
        revolve: object.revolve,
        revolvedUntil: parts.revolvedUntil,
      },
      layout.camera,
      thermal,
    );
  }, [
    parts,
    thermal,
    layout.camera,
    layout.viewDir,
    object.position,
    object.yawRad,
    object.tiltRad,
    object.bbox,
    object.revolve,
  ]);

  // A held object leans about the view axis (through its bottom centre), after its yaw — the same
  // order the projection above uses, so the paint lands where the mesh is.
  const tilt = useMemo(
    () => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...layout.viewDir), object.tiltRad),
    [layout.viewDir, object.tiltRad],
  );

  // Vertex colours for the thermal / blended modes. Inferred vertices are pulled toward grey (or
  // shown grey outright when only measured paint is wanted), so what the camera never saw reads as such.
  useEffect(() => {
    if (!painted) return;
    const colors = colorAttr.array as Float32Array;
    const n = Math.min(painted.t01.length, colors.length / 3);
    const base = new THREE.Color(parts.baseColor);
    for (let i = 0; i < n; i++) {
      const k = Math.round(painted.t01[i] * 255) * 3;
      let r = lut[k];
      let g = lut[k + 1];
      let b = lut[k + 2];
      if (!painted.measured[i]) {
        // Inferred paint (the back, the part out of frame) is the visible side's height profile — a
        // sound guess for a thin-walled vessel — so it stays readable, just a little muted.
        const w = measuredOnly ? 1 : 0.25;
        r = r * (1 - w) + GRAY * w;
        g = g * (1 - w) + GRAY * w;
        b = b * (1 - w) + GRAY * w;
      }
      if (mode === 'blended') {
        r = r * 0.6 + base.r * 0.4;
        g = g * 0.6 + base.g * 0.4;
        b = b * 0.6 + base.b * 0.4;
      }
      colors[i * 3] = r;
      colors[i * 3 + 1] = g;
      colors[i * 3 + 2] = b;
    }
    colorAttr.needsUpdate = true;
  }, [painted, colorAttr, parts.baseColor, lut, mode, measuredOnly]);

  const thermalPaint = mode !== 'realistic' && !!painted;
  const label = `${object.spec ?? kindLabel(object.kind)}${
    painted?.meanC != null ? ` · ${displayTemp(painted.meanC, unit).toFixed(1)}${temperatureSymbol(unit)}` : ''
  }`;

  return (
    <group position={object.position} quaternion={tilt}>
      <group rotation={[0, object.yawRad, 0]}>
        <mesh geometry={parts.body}>
          {thermalPaint ? (
            <meshStandardMaterial
              vertexColors
              roughness={0.8}
              metalness={0.05}
              side={THREE.DoubleSide}
              transparent={mode === 'blended'}
              opacity={mode === 'blended' ? 0.92 : 1}
            />
          ) : (
            <meshPhysicalMaterial
              color={parts.baseColor}
              transparent={parts.opacity < 1}
              opacity={parts.opacity}
              roughness={0.35}
              metalness={parts.metalness}
              side={THREE.DoubleSide}
              depthWrite={parts.opacity >= 1}
            />
          )}
        </mesh>
        {parts.liquid && !thermalPaint && (
          <mesh geometry={parts.liquid}>
            <meshStandardMaterial color={parts.liquidColor} transparent opacity={0.75} roughness={0.2} />
          </mesh>
        )}
        {parts.extras.map((e, i) => (
          <mesh key={i} geometry={e.geometry}>
            <meshStandardMaterial
              color={e.color}
              emissive={e.emissive ?? '#000000'}
              emissiveIntensity={e.emissive ? 0.9 : 0}
              transparent={(e.opacity ?? 1) < 1}
              opacity={e.opacity ?? 1}
            />
          </mesh>
        ))}
        {showLabels && (
          <Html position={[0, object.heightM + 0.02, 0]} center zIndexRange={[10, 0]}>
            <div style={labelStyle}>{label}</div>
          </Html>
        )}
      </group>
    </group>
  );
};

const deg2rad = (d: number) => (d * Math.PI) / 180;

const TwinScene3D = ({ layout, thermal, palette, mode, measuredOnly, showLabels, unit, resetNonce }: Props) => {
  const lut = useColorLut(palette);
  const { camera, focus, extentM } = layout;
  // Orbit around a point straight down the photographed view axis, as far away as the apparatus is, so
  // the initial view IS the photo's and orbiting pivots about the scene rather than the table corner.
  const target = useMemo<[number, number, number]>(() => {
    const dist =
      Math.hypot(focus[0] - camera.position[0], focus[1] - camera.position[1], focus[2] - camera.position[2]) || 0.6;
    const th = deg2rad(camera.pitchDeg);
    return [camera.position[0], camera.position[1] - dist * Math.sin(th), camera.position[2] - dist * Math.cos(th)];
  }, [camera, focus]);
  const drawn = layout.placed.filter((p) => p.rendered);

  return (
    <Canvas style={{ display: 'block', width: '100%', height: '100%' }} dpr={[1, 2]} gl={{ antialias: true }}>
      <PerspectiveCamera
        key={resetNonce}
        makeDefault
        fov={STREET_VIEW_VFOV}
        near={0.01}
        far={50}
        position={camera.position}
        rotation={[-deg2rad(camera.pitchDeg), 0, 0]}
      />
      <color attach="background" args={['#f3f1ec']} />
      <ambientLight intensity={0.75} />
      <directionalLight position={[1, 2, 1]} intensity={1.0} />
      <directionalLight position={[-1, 1.2, -0.5]} intensity={0.35} />
      {/* The support surface: a plane at y = 0 under the apparatus, with a 5 cm grid for scale. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[focus[0], -0.0005, focus[2]]}>
        <planeGeometry args={[2 * extentM, 2 * extentM]} />
        <meshStandardMaterial color="#e6dccb" roughness={0.95} />
      </mesh>
      <gridHelper
        args={[2 * extentM, Math.max(2, Math.round((2 * extentM) / 0.05)), '#c4b9a6', '#d8cfc0']}
        position={[focus[0], 0.0005, focus[2]]}
      />
      {drawn.map((o) => (
        <PropMesh
          key={o.id}
          object={o}
          layout={layout}
          thermal={thermal}
          lut={lut}
          mode={mode}
          measuredOnly={measuredOnly}
          showLabels={showLabels}
          unit={unit}
        />
      ))}
      <OrbitControls key={`orbit-${resetNonce}`} target={target} enablePan minDistance={0.05} maxDistance={8} />
    </Canvas>
  );
};

export default TwinScene3D;
