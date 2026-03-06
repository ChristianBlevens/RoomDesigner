// Admin 3D viewer for inspecting room meshes and furniture models

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

async function fetchBlobUrl(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) return null;
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

let currentRenderer = null;
let currentScene = null;
let currentCamera = null;
let currentControls = null;
let currentAnimationId = null;

function cleanup() {
  if (currentAnimationId) cancelAnimationFrame(currentAnimationId);
  if (currentControls) currentControls.dispose();
  if (currentRenderer) currentRenderer.dispose();
  if (currentScene) {
    currentScene.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
        else obj.material.dispose();
      }
    });
  }
  currentRenderer = null;
  currentScene = null;
  currentCamera = null;
  currentControls = null;
  currentAnimationId = null;
}

function setupRenderer(canvas) {
  cleanup();

  const container = canvas.parentElement;
  const width = container.clientWidth;
  const height = Math.min(width * 0.75, 500);
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = false;

  currentRenderer = renderer;
  return { renderer, width, height };
}

function startRenderLoop() {
  function animate() {
    currentAnimationId = requestAnimationFrame(animate);
    if (currentControls) currentControls.update();
    if (currentRenderer && currentScene && currentCamera) {
      currentRenderer.render(currentScene, currentCamera);
    }
  }
  animate();
}

/**
 * Load a room mesh with background photo — replicates debug mode view.
 * Green wireframe mesh over the room photo, with MoGe-aligned camera.
 */
export async function loadRoom(canvas, meshUrl, backgroundUrl, mogeData) {
  const { renderer, width, height } = setupRenderer(canvas);
  const infoEl = document.getElementById('admin-viewer-info');

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111111);
  currentScene = scene;

  // Camera from MoGe data
  const fov = mogeData.cameraFov || 60;
  const aspect = mogeData.imageAspect || (width / height);
  const camera = new THREE.PerspectiveCamera(fov, aspect, 0.01, 100);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);
  currentCamera = camera;

  // Adjust renderer size to match aspect
  const displayWidth = width;
  const displayHeight = Math.round(displayWidth / aspect);
  renderer.setSize(displayWidth, displayHeight);
  canvas.style.width = displayWidth + 'px';
  canvas.style.height = displayHeight + 'px';

  // Controls
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0, -2);
  controls.update();
  currentControls = controls;

  // Ambient light
  scene.add(new THREE.AmbientLight(0xffffff, 0.5));

  // Fetch mesh as blob to avoid CORS cache issues
  const meshBlobUrl = await fetchBlobUrl(meshUrl);
  if (!meshBlobUrl) {
    if (infoEl) infoEl.textContent = 'Failed to fetch mesh';
    startRenderLoop();
    return;
  }

  const loader = new GLTFLoader();
  loader.load(meshBlobUrl, async (gltf) => {
    URL.revokeObjectURL(meshBlobUrl);

    gltf.scene.traverse(child => {
      if (child.isMesh) {
        child.material = new THREE.MeshBasicMaterial({
          color: 0x00ff00,
          wireframe: true,
          transparent: true,
          opacity: 0.6,
        });
      }
    });
    scene.add(gltf.scene);

    // Compute bounds for background plane placement
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());

    if (infoEl) {
      infoEl.textContent = `Mesh bounds: ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)} | Center: [${center.x.toFixed(2)}, ${center.y.toFixed(2)}, ${center.z.toFixed(2)}]`;
    }

    // Place background image behind mesh
    if (backgroundUrl) {
      const bgBlobUrl = await fetchBlobUrl(backgroundUrl);
      if (bgBlobUrl) {
        const texLoader = new THREE.TextureLoader();
        texLoader.load(bgBlobUrl, (texture) => {
          URL.revokeObjectURL(bgBlobUrl);
          texture.colorSpace = THREE.SRGBColorSpace;
          const depth = box.max.z < 0 ? box.min.z - 1 : box.max.z + 1;
          const planeHeight = 2 * Math.abs(depth) * Math.tan(THREE.MathUtils.degToRad(fov / 2));
          const planeWidth = planeHeight * aspect;

          const planeGeo = new THREE.PlaneGeometry(planeWidth, planeHeight);
          const planeMat = new THREE.MeshBasicMaterial({
            map: texture,
            toneMapped: false,
            depthWrite: false,
          });
          const plane = new THREE.Mesh(planeGeo, planeMat);
          plane.position.set(0, 0, depth);
          plane.renderOrder = -1;
          scene.add(plane);
        });
      }
    }

    // Frame the view
    controls.target.copy(center);
    camera.position.set(center.x, center.y, center.z + size.length() * 0.5);
    controls.update();
  }, undefined, (err) => {
    URL.revokeObjectURL(meshBlobUrl);
    if (infoEl) infoEl.textContent = `Failed to load mesh: ${err.message}`;
  });

  startRenderLoop();
}

/**
 * Load a furniture GLB model with auto-framing.
 */
export async function loadFurniture(canvas, modelUrl) {
  const { renderer, width, height } = setupRenderer(canvas);
  const infoEl = document.getElementById('admin-viewer-info');

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1b2838);
  currentScene = scene;

  const camera = new THREE.PerspectiveCamera(50, width / height, 0.01, 100);
  currentCamera = camera;

  const controls = new OrbitControls(camera, canvas);
  currentControls = controls;

  // Lighting
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(2, 4, 3);
  scene.add(dirLight);

  // Grid
  const grid = new THREE.GridHelper(4, 20, 0x444444, 0x333333);
  scene.add(grid);

  // Fetch model as blob to avoid CORS cache issues
  const blobUrl = await fetchBlobUrl(modelUrl);
  if (!blobUrl) {
    if (infoEl) infoEl.textContent = 'Failed to fetch model';
    startRenderLoop();
    return;
  }

  const loader = new GLTFLoader();
  loader.load(blobUrl, (gltf) => {
    URL.revokeObjectURL(blobUrl);
    scene.add(gltf.scene);

    const box = new THREE.Box3().setFromObject(gltf.scene);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);

    if (infoEl) {
      infoEl.textContent = `Size: ${size.x.toFixed(3)} x ${size.y.toFixed(3)} x ${size.z.toFixed(3)}m`;
    }

    // Frame camera
    controls.target.copy(center);
    const dist = maxDim * 2;
    camera.position.set(center.x + dist * 0.5, center.y + dist * 0.3, center.z + dist * 0.5);
    controls.update();
  }, undefined, (err) => {
    URL.revokeObjectURL(blobUrl);
    if (infoEl) infoEl.textContent = `Failed to load model: ${err.message}`;
  });

  startRenderLoop();
}

export function disposeViewer() {
  cleanup();
}
