import { forwardRef, useEffect, useMemo, useRef } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Html } from '@react-three/drei';
import * as THREE from 'three';
import { temp01ToRgb } from '../../../utils/colormap';
import { computeIsotherms } from '../../../utils/isotherms';
import { IR_ARRAY_HEIGHT, IR_ARRAY_WIDTH } from '../../../utils/constants';
import { displayTemp, temperatureSymbol } from '../../../utils/helpers';
import { TemperatureUnit } from '../../../types';

const ISO_LEVELS = 6;

// This module imports three.js and is code-split (loaded lazily on first modal open).

// Plane footprint (keeps the 120x160 sensor aspect ratio) and how tall the relief stands.
const PLANE_W = 1.2;
const PLANE_H = 1.6;
const RELIEF = 0.6;

interface SurfaceMeshProps {
  grid: number[];
  min: number;
  max: number;
}

/** A displaced, vertex-colored plane: height = temperature, color = blue→red ramp. */
const SurfaceMesh = forwardRef<THREE.Mesh, SurfaceMeshProps>(({ grid, min, max }, ref) => {
  const geometry = useMemo(() => {
    const w = IR_ARRAY_WIDTH;
    const h = IR_ARRAY_HEIGHT;
    const geo = new THREE.PlaneGeometry(PLANE_W, PLANE_H, w - 1, h - 1);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const span = max - min || 1;
    for (let i = 0; i < pos.count; i++) {
      const t = (grid[i] - min) / span; // 0..1 within this frame's range
      pos.setZ(i, t * RELIEF); // displace before rotation → becomes "up"
      const [r, g, b] = temp01ToRgb(t);
      colors[i * 3] = r;
      colors[i * 3 + 1] = g;
      colors[i * 3 + 2] = b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    return geo;
  }, [grid, min, max]);

  // Dispose the previous geometry when it changes or the mesh unmounts.
  useEffect(() => () => geometry.dispose(), [geometry]);

  // Lay the plane flat (height along world +Y) so OrbitControls reads it as a landscape.
  return (
    <mesh ref={ref} geometry={geometry} rotation={[-Math.PI / 2, 0, 0]}>
      <meshStandardMaterial vertexColors roughness={0.85} metalness={0.05} side={THREE.DoubleSide} />
    </mesh>
  );
});
SurfaceMesh.displayName = 'SurfaceMesh';

// World-space extent of the surface volume (the mesh is a PlaneGeometry rotated flat):
//   X = image width, Y = temperature (height), Z = image height.
const X0 = -PLANE_W / 2;
const X1 = PLANE_W / 2;
const Y0 = 0;
const Y1 = RELIEF;
const Z0 = -PLANE_H / 2;
const Z1 = PLANE_H / 2;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Floor + two far walls of gridlines forming a 3-axis coordinate box around the surface. */
const GridLines = () => {
  const geometry = useMemo(() => {
    const nx = 6;
    const ny = 5;
    const nz = 8;
    const p: number[] = [];
    // floor (Y = Y0)
    for (let i = 0; i <= nx; i++) {
      const x = lerp(X0, X1, i / nx);
      p.push(x, Y0, Z0, x, Y0, Z1);
    }
    for (let k = 0; k <= nz; k++) {
      const z = lerp(Z0, Z1, k / nz);
      p.push(X0, Y0, z, X1, Y0, z);
    }
    // far wall (Z = Z0)
    for (let i = 0; i <= nx; i++) {
      const x = lerp(X0, X1, i / nx);
      p.push(x, Y0, Z0, x, Y1, Z0);
    }
    for (let j = 0; j <= ny; j++) {
      const y = lerp(Y0, Y1, j / ny);
      p.push(X0, y, Z0, X1, y, Z0);
    }
    // left wall (X = X0)
    for (let k = 0; k <= nz; k++) {
      const z = lerp(Z0, Z1, k / nz);
      p.push(X0, Y0, z, X0, Y1, z);
    }
    for (let j = 0; j <= ny; j++) {
      const y = lerp(Y0, Y1, j / ny);
      p.push(X0, y, Z0, X0, y, Z1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    return g;
  }, []);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial color="#7d9bbd" transparent opacity={0.9} />
    </lineSegments>
  );
};

const labelStyle: React.CSSProperties = {
  color: '#cfe3ff',
  fontSize: 11,
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
  userSelect: 'none',
  textShadow: '0 1px 2px rgba(0,0,0,0.85)',
};
const titleStyle: React.CSSProperties = { ...labelStyle, fontSize: 12, fontWeight: 600, color: '#9fb6d0' };

interface LabelProps {
  min: number;
  max: number;
  unit: TemperatureUnit;
  // The surface mesh to depth-test labels against, so a tick hides when the relief is in front of it.
  occludeRef: RefObject<THREE.Mesh>;
}

const TICKS = [0, 0.5, 1];

/** Numeric tick values on all three axes (temperature + image pixel coordinates) and axis titles. */
const AxesLabels = ({ min, max, unit, occludeRef }: LabelProps) => {
  const sym = temperatureSymbol(unit);
  // drei raycasts toward each <Html> and hides it whenever this mesh sits between it and the camera.
  const occlude = useMemo(() => [occludeRef], [occludeRef]);
  return (
    <>
      {/* temperature scale (vertical / Y) */}
      {TICKS.map((f) => (
        <Html key={`t${f}`} position={[X0 - 0.06, lerp(Y0, Y1, f), Z1]} center style={labelStyle} occlude={occlude}>
          {displayTemp(min + (max - min) * f, unit).toFixed(1)} {sym}
        </Html>
      ))}
      {/* image-x ticks (width / X), normalized 0–1 to match the T(x) chart */}
      {TICKS.map((f) => (
        <Html
          key={`w${f}`}
          position={[lerp(X0, X1, f), Y0 - 0.04, Z1 + 0.05]}
          center
          style={labelStyle}
          occlude={occlude}
        >
          {f}
        </Html>
      ))}
      {/* image-y ticks (height / Z), normalized 0–1 to match the T(y) chart */}
      {TICKS.map((f) => (
        <Html
          key={`h${f}`}
          position={[X0 - 0.09, Y0 - 0.04, lerp(Z0, Z1, f)]}
          center
          style={labelStyle}
          occlude={occlude}
        >
          {f}
        </Html>
      ))}
      <Html position={[X0 - 0.06, Y1 + 0.1, Z1]} center style={titleStyle} occlude={occlude}>
        Temp
      </Html>
      <Html position={[0, Y0 - 0.12, Z1 + 0.1]} center style={titleStyle} occlude={occlude}>
        Width
      </Html>
      <Html position={[X0 - 0.2, Y0 - 0.12, 0]} center style={titleStyle} occlude={occlude}>
        Height
      </Html>
    </>
  );
};

/**
 * Isotherm contour lines traced on the surface. Because height encodes temperature, an isotherm at
 * temperature T is a horizontal slice at constant world-Y — classic topographic contours.
 */
const Isotherms3D = ({ grid, min, max }: { grid: number[]; min: number; max: number }) => {
  const geometry = useMemo(() => {
    const lines = computeIsotherms(grid, IR_ARRAY_WIDTH, IR_ARRAY_HEIGHT, ISO_LEVELS);
    const span = max - min || 1;
    const p: number[] = [];
    const c: number[] = [];
    for (const line of lines) {
      const t = (line.value - min) / span; // 0..1 → blue→red, matching the surface ramp
      const y = t * RELIEF + 0.006; // lifted slightly to avoid z-fighting with the surface
      const [r, g, b] = temp01ToRgb(t);
      for (const s of line.segments) {
        p.push(lerp(X0, X1, s[0]), y, lerp(Z0, Z1, s[1]), lerp(X0, X1, s[2]), y, lerp(Z0, Z1, s[3]));
        c.push(r, g, b, r, g, b);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
    return g;
  }, [grid, min, max]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  // Unlit (lineBasicMaterial) so the contours stay bright against the shaded surface.
  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial vertexColors transparent opacity={0.95} />
    </lineSegments>
  );
};

interface Props {
  grid: number[];
  min: number;
  max: number;
  unit: TemperatureUnit;
  showGrid: boolean;
  showIsotherms: boolean;
  // Captures the WebGL renderer so the parent can read its canvas for PNG export.
  glRef: MutableRefObject<{ domElement: HTMLCanvasElement } | null>;
}

const Surface3DScene = ({ grid, min, max, unit, showGrid, showIsotherms, glRef }: Props) => {
  const meshRef = useRef<THREE.Mesh>(null);
  return (
    <Canvas
      style={{ display: 'block' }}
      camera={{ position: [1.5, 1.25, 1.5], fov: 45 }}
      dpr={[1, 2]}
      gl={{ preserveDrawingBuffer: true }} // required so toDataURL() can read the frame for export
      onCreated={({ gl }) => {
        glRef.current = gl;
      }}
    >
      <ambientLight intensity={0.7} />
      <directionalLight position={[3, 5, 2]} intensity={1.1} />
      <directionalLight position={[-3, 2, -2]} intensity={0.35} />
      <SurfaceMesh ref={meshRef} grid={grid} min={min} max={max} />
      {showGrid && <GridLines />}
      {showGrid && <AxesLabels min={min} max={max} unit={unit} occludeRef={meshRef} />}
      {showIsotherms && <Isotherms3D grid={grid} min={min} max={max} />}
      <OrbitControls enablePan={false} minDistance={1.2} maxDistance={6} target={[0, 0.2, 0]} />
    </Canvas>
  );
};

export default Surface3DScene;
