"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { tryCompileFormula } from "@/lib/expression";
import type { GraphPoint, GraphSurface, GraphWindow3D } from "@/lib/graph";
import { formatTick, niceStep, tickValues } from "@/lib/plot";
import { surfaceMesh } from "@/lib/surface";
import { CURVE_COLORS } from "./FunctionPlot";

interface Plot3DProps {
  surfaces: GraphSurface[];
  points: GraphPoint[];
  /** The box of 3D space to show. */
  box: GraphWindow3D;
  /** Width and height of the view, in pixels. */
  size: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const buttonClass =
  "grid size-10 place-items-center rounded-lg border border-neutral-300 bg-white/90 text-lg font-medium text-neutral-800 transition-colors hover:bg-neutral-100";

/**
 * A 3D view you can turn and zoom: drag to rotate, scroll or pinch to zoom, right-drag
 * or two fingers to move. Maths has z pointing up, so a point (x, y, z) is shown at
 * (x, z, -y) in three.js, which has y pointing up.
 */
export default function Plot3D({ surfaces, points, box, size }: Plot3DProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const actions = useRef<{ reset: () => void; zoom: (factor: number) => void }>({
    reset: () => {},
    zoom: () => {},
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      host.textContent = "3D graphics aren't available in this browser.";
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(size, size);
    renderer.setClearColor(0xffffff);
    renderer.domElement.style.display = "block";
    host.appendChild(renderer.domElement);

    const disposables: { dispose(): void }[] = [];
    const track = <T extends { dispose(): void }>(item: T): T => {
      disposables.push(item);
      return item;
    };

    const toScene = (x: number, y: number, z: number) => new THREE.Vector3(x, z, -y);
    const xSpan = box.xMax - box.xMin;
    const ySpan = box.yMax - box.yMin;
    const zSpan = box.zMax - box.zMin;
    const span = Math.max(xSpan, ySpan, zSpan);
    const center = toScene((box.xMin + box.xMax) / 2, (box.yMin + box.yMax) / 2, (box.zMin + box.zMax) / 2);

    const scene = new THREE.Scene();
    // Soft light from everywhere plus one from above, so slopes shade differently and read as 3D.
    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(1, 2, 1.5);
    scene.add(sun);

    const camera = new THREE.PerspectiveCamera(40, 1, span * 0.02, span * 40);
    const home = center.clone().add(new THREE.Vector3(1, 0.75, 1.35).multiplyScalar(span * 1.05));
    camera.position.copy(home);
    camera.lookAt(center);

    // A light box around the part of space shown.
    const frame = new THREE.LineSegments(
      track(new THREE.EdgesGeometry(track(new THREE.BoxGeometry(xSpan, zSpan, ySpan)))),
      track(new THREE.LineBasicMaterial({ color: 0xd4d4d4 })),
    );
    frame.position.copy(center);
    scene.add(frame);

    // Axes cross at the origin, or at the nearest edge of the box if the origin is outside it.
    const ox = clamp(0, box.xMin, box.xMax);
    const oy = clamp(0, box.yMin, box.yMax);
    const oz = clamp(0, box.zMin, box.zMax);
    const axisMaterial = track(new THREE.LineBasicMaterial({ color: 0x404040 }));
    const addAxis = (from: THREE.Vector3, to: THREE.Vector3) => {
      scene.add(new THREE.Line(track(new THREE.BufferGeometry().setFromPoints([from, to])), axisMaterial));
    };
    addAxis(toScene(box.xMin, oy, oz), toScene(box.xMax, oy, oz));
    addAxis(toScene(ox, box.yMin, oz), toScene(ox, box.yMax, oz));
    addAxis(toScene(ox, oy, box.zMin), toScene(ox, oy, box.zMax));

    // Text that always faces the camera.
    const measure = document.createElement("canvas").getContext("2d");
    const addLabel = (text: string, at: THREE.Vector3, height: number, bold = false, color = "#404040") => {
      if (!measure) return;
      const font = `${bold ? "bold " : ""}44px sans-serif`;
      measure.font = font;
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(measure.measureText(text).width) + 20;
      canvas.height = 64;
      const g = canvas.getContext("2d");
      if (!g) return;
      g.font = font;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillStyle = color;
      g.fillText(text, canvas.width / 2, 34);

      const texture = track(new THREE.CanvasTexture(canvas));
      texture.colorSpace = THREE.SRGBColorSpace;
      const sprite = new THREE.Sprite(
        track(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true })),
      );
      sprite.scale.set((height * canvas.width) / 64, height, 1);
      sprite.position.copy(at);
      scene.add(sprite);
    };

    const tickHeight = span * 0.05;
    for (const t of tickValues(box.xMin, box.xMax, niceStep(xSpan, 6))) {
      if (t !== 0) addLabel(formatTick(t, niceStep(xSpan, 6)), toScene(t, oy - 0.05 * span, oz - 0.03 * span), tickHeight);
    }
    for (const t of tickValues(box.yMin, box.yMax, niceStep(ySpan, 6))) {
      if (t !== 0) addLabel(formatTick(t, niceStep(ySpan, 6)), toScene(ox + 0.05 * span, t, oz - 0.03 * span), tickHeight);
    }
    for (const t of tickValues(box.zMin, box.zMax, niceStep(zSpan, 6))) {
      if (t !== 0) addLabel(formatTick(t, niceStep(zSpan, 6)), toScene(ox + 0.05 * span, oy - 0.05 * span, t), tickHeight);
    }
    addLabel("x", toScene(box.xMax + 0.06 * span, oy, oz), span * 0.07, true, "#111111");
    addLabel("y", toScene(ox, box.yMax + 0.06 * span, oz), span * 0.07, true, "#111111");
    addLabel("z", toScene(ox, oy, box.zMax + 0.06 * span), span * 0.07, true, "#111111");

    // The surfaces: one solid one stays opaque; several are see-through so you can see where they cross.
    surfaces.forEach((surface, index) => {
      const formula = tryCompileFormula(surface.expression);
      if (!formula) return;
      const mesh = surfaceMesh(formula, surface.solveFor, box);

      const positions = new Float32Array(mesh.positions.length);
      for (let k = 0; k < positions.length; k += 3) {
        positions[k] = mesh.positions[k];
        positions[k + 1] = mesh.positions[k + 2];
        positions[k + 2] = -mesh.positions[k + 1];
      }
      const attribute = new THREE.BufferAttribute(positions, 3);
      const color = new THREE.Color(CURVE_COLORS[index % CURVE_COLORS.length]);
      const alone = surfaces.length === 1;

      const faces = track(new THREE.BufferGeometry());
      faces.setAttribute("position", attribute);
      faces.setIndex(new THREE.BufferAttribute(mesh.triangles, 1));
      faces.computeVertexNormals();

      const material = (side: THREE.Side) =>
        track(
          new THREE.MeshStandardMaterial({
            color,
            side,
            roughness: 0.85,
            metalness: 0,
            transparent: !alone,
            opacity: alone ? 1 : 0.6,
            depthWrite: alone,
            // Sit slightly behind the wire lines drawn on the surface, so they don't flicker.
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1,
          }),
        );

      if (alone) {
        scene.add(new THREE.Mesh(faces, material(THREE.DoubleSide)));
      } else {
        // See-through surfaces blend in the order they are drawn, which looks blotchy if the
        // order is arbitrary. So draw the far side of every surface first, then the near side.
        const far = new THREE.Mesh(faces, material(THREE.BackSide));
        far.renderOrder = 1;
        const near = new THREE.Mesh(faces, material(THREE.FrontSide));
        near.renderOrder = 2;
        scene.add(far, near);
      }

      const wire = track(new THREE.BufferGeometry());
      wire.setAttribute("position", attribute);
      wire.setIndex(new THREE.BufferAttribute(mesh.lines, 1));
      const grid = new THREE.LineSegments(
        wire,
        track(new THREE.LineBasicMaterial({ color: color.clone().multiplyScalar(0.55), transparent: true, opacity: 0.55 })),
      );
      grid.renderOrder = 3;
      scene.add(grid);
    });

    // Marked points, such as where the surfaces of a system meet.
    for (const point of points) {
      const marker = new THREE.Mesh(
        track(new THREE.SphereGeometry(span * 0.018, 20, 20)),
        track(new THREE.MeshBasicMaterial({ color: 0x111111 })),
      );
      marker.position.copy(toScene(point.x, point.y, point.z));
      scene.add(marker);
      addLabel(point.label, toScene(point.x, point.y, point.z + 0.07 * span), span * 0.06, true, "#111111");
    }

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(center);
    controls.minDistance = span * 0.3;
    controls.maxDistance = span * 6;
    controls.update();

    // Draw only when something changes, so many cards don't keep the graphics card busy.
    const render = () => renderer.render(scene, camera);
    controls.addEventListener("change", render);
    render();

    actions.current = {
      reset: () => {
        camera.position.copy(home);
        controls.target.copy(center);
        controls.update();
        render();
      },
      zoom: (factor) => {
        camera.position.sub(controls.target).multiplyScalar(factor).add(controls.target);
        controls.update();
        render();
      },
    };

    return () => {
      controls.removeEventListener("change", render);
      controls.dispose();
      for (const item of disposables) item.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [surfaces, points, box, size]);

  return (
    // data-no-pan: scrolling over the 3D view zooms it instead of scrolling the board.
    <div data-no-pan className="relative" style={{ width: size, height: size }}>
      <div
        ref={hostRef}
        className="overflow-hidden rounded-lg border border-neutral-200 bg-white"
        style={{ width: size, height: size }}
      />
      <div className="absolute bottom-2 right-2 flex gap-1.5">
        <button type="button" aria-label="Zoom out" className={buttonClass} onClick={() => actions.current.zoom(1.25)}>
          −
        </button>
        <button type="button" aria-label="Zoom in" className={buttonClass} onClick={() => actions.current.zoom(0.8)}>
          +
        </button>
        <button type="button" className={`${buttonClass} px-3 text-sm`} onClick={() => actions.current.reset()}>
          Reset
        </button>
      </div>
    </div>
  );
}
