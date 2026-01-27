// Three.js scene setup for Room Furniture Planner

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { adjustUrlForProxy } from './api.js';

// Scene state
let scene, camera, renderer;
let transformControls;
let gltfLoader;
let floor;
let roomWireframe;
let roomGeometryModel = null;
let backgroundImagePlane = null;
let backgroundImageTexture = null;
let directionalLight = null;

// Aspect ratio locking for MoGe alignment preservation
let lockedImageAspect = null;  // When set, camera maintains this aspect ratio during resize

// Lighting direction gizmo
let lightingGizmo = null;
let lightingGizmoSource = null;  // Sphere at light source
let lightingGizmoTarget = null;  // Sphere at light target
let lightingGizmoLine = null;    // Line connecting them
let lightingGizmoArrow = null;   // Arrow head

// Room mesh for raycasting (invisible) and debug visualization (wireframe)
let roomMesh = null;
let roomMeshWireframe = null;

// Room bounds (the 3D cube representing the room) - can be updated by MoGe-2
let roomBounds = new THREE.Box3(
  new THREE.Vector3(-5, 0, -5),
  new THREE.Vector3(5, 4, 5)
);

// Selectable furniture objects
export const selectableObjects = [];

// Room-wide scale factor (multiplies individual furniture base scales)
let roomScaleFactor = 1.0;

// Raycaster for mouse interactions
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

// Debug camera state
let debugCameraEnabled = false;
let savedCameraState = null;
let debugCameraVelocity = { x: 0, y: 0, z: 0 };
let debugCameraRotation = { yaw: 0, pitch: 0 };
let debugKeysPressed = {};
let debugMouseDown = false;
let debugLastMouseX = 0;
let debugLastMouseY = 0;

// Export getters
export function getScene() { return scene; }
export function getCamera() { return camera; }
export function getRenderer() { return renderer; }
export function getTransformControls() { return transformControls; }
export function getRoomBounds() { return roomBounds; }
export function isDebugCameraEnabled() { return debugCameraEnabled; }
export function getRoomMesh() { return roomMesh; }

/**
 * Set room mesh visibility (for debug mode).
 * @param {boolean} visible - Whether mesh wireframe should be visible
 */
export function setRoomMeshVisible(visible) {
  if (roomMeshWireframe) {
    roomMeshWireframe.visible = visible;
  }
}

/**
 * Raycast against room mesh to find surface position and normal.
 * Uses normal averaging across multiple samples for stability.
 * @param {MouseEvent} event - Mouse event
 * @param {Object} options - Options for raycasting
 * @param {number} options.averagingRadius - Screen-space radius for normal averaging (pixels, default 10)
 * @param {number} options.sampleCount - Number of samples for averaging (default 8)
 * @returns {Object|null} - { point: Vector3, normal: Vector3, distance: number } or null
 */
export function raycastRoomSurface(event, options = {}) {
  const {
    averagingRadius = 10,
    sampleCount = 8
  } = options;

  updateMouse(event);
  raycaster.setFromCamera(mouse, camera);

  if (roomMesh) {
    const intersects = raycaster.intersectObject(roomMesh, true);

    if (intersects.length > 0) {
      const hit = intersects[0];
      const hitPoint = hit.point.clone();

      // Get the primary normal
      const primaryNormal = hit.face.normal.clone()
        .transformDirection(hit.object.matrixWorld)
        .normalize();

      // Fast path: skip averaging if sampleCount is 0 (used during drag for performance)
      if (sampleCount <= 0) {
        return {
          point: hitPoint,
          normal: primaryNormal,
          distance: hit.distance,
          face: hit.face,
          sampleCount: 1
        };
      }

      // Collect additional normals by casting rays around the hit point
      const normals = [primaryNormal];
      const rect = renderer.domElement.getBoundingClientRect();

      for (let i = 0; i < sampleCount; i++) {
        const angle = (i / sampleCount) * Math.PI * 2;
        const offsetX = Math.cos(angle) * averagingRadius;
        const offsetY = Math.sin(angle) * averagingRadius;

        // Create offset mouse position in NDC
        const sampleMouse = new THREE.Vector2(
          ((event.clientX + offsetX - rect.left) / rect.width) * 2 - 1,
          -((event.clientY + offsetY - rect.top) / rect.height) * 2 + 1
        );

        raycaster.setFromCamera(sampleMouse, camera);
        const sampleIntersects = raycaster.intersectObject(roomMesh, true);

        if (sampleIntersects.length > 0) {
          const sampleNormal = sampleIntersects[0].face.normal.clone()
            .transformDirection(sampleIntersects[0].object.matrixWorld)
            .normalize();
          normals.push(sampleNormal);
        }
      }

      // Average all collected normals
      const averagedNormal = new THREE.Vector3(0, 0, 0);
      for (const n of normals) {
        averagedNormal.add(n);
      }
      averagedNormal.divideScalar(normals.length).normalize();

      return {
        point: hitPoint,
        normal: averagedNormal,
        distance: hit.distance,
        face: hit.face,
        sampleCount: normals.length
      };
    }
  }

  // Fallback to floor plane if no mesh or no hit
  const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const intersectPoint = new THREE.Vector3();
  raycaster.ray.intersectPlane(floorPlane, intersectPoint);

  if (intersectPoint) {
    return {
      point: intersectPoint,
      normal: new THREE.Vector3(0, 1, 0),
      distance: intersectPoint.distanceTo(camera.position),
      face: null
    };
  }

  return null;
}

/**
 * Get debug info about the current scene state.
 * @returns {Object} Debug information
 */
export function getDebugInfo() {
  const info = {
    camera: camera ? {
      position: camera.position.toArray().map(v => v.toFixed(2)),
      rotation: [camera.rotation.x, camera.rotation.y, camera.rotation.z].map(v => (v * 180 / Math.PI).toFixed(1) + '°'),
      fov: camera.fov.toFixed(1) + '°',
      near: camera.near,
      far: camera.far,
      lookingAt: (() => {
        const dir = new THREE.Vector3();
        camera.getWorldDirection(dir);
        return dir.toArray().map(v => v.toFixed(2));
      })()
    } : null,
    roomBounds: {
      min: roomBounds.min.toArray().map(v => v.toFixed(2)),
      max: roomBounds.max.toArray().map(v => v.toFixed(2)),
      size: (() => {
        const size = new THREE.Vector3();
        roomBounds.getSize(size);
        return size.toArray().map(v => v.toFixed(2));
      })()
    },
    roomMesh: roomMesh ? {
      loaded: true,
      wireframeVisible: roomMeshWireframe?.visible || false,
      bounds: {
        min: roomBounds.min.toArray().map(v => v.toFixed(2)),
        max: roomBounds.max.toArray().map(v => v.toFixed(2))
      }
    } : 'not loaded',
    defaultRoom: {
      floorVisible: floor ? floor.visible : 'N/A',
      wireframeVisible: roomWireframe ? roomWireframe.visible : 'N/A'
    },
    backgroundPlane: backgroundImagePlane ? {
      position: backgroundImagePlane.position.toArray().map(v => v.toFixed(2)),
      size: [
        backgroundImagePlane.geometry.parameters.width.toFixed(2),
        backgroundImagePlane.geometry.parameters.height.toFixed(2)
      ]
    } : 'not loaded',
    furniture: selectableObjects.map(obj => ({
      entryId: obj.userData.entryId,
      position: obj.position.toArray().map(v => v.toFixed(2)),
      visible: obj.visible
    })),
    sceneChildren: scene ? scene.children.length : 0,
    debugCamera: debugCameraEnabled
  };
  return info;
}

/**
 * Enable debug camera mode - free-flying WASD + mouse controls.
 */
export function enableDebugCamera() {
  if (!camera || debugCameraEnabled) return;

  // Save current camera state
  savedCameraState = {
    position: camera.position.clone(),
    rotation: camera.rotation.clone(),
    fov: camera.fov
  };

  // Calculate initial yaw/pitch from camera direction
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  debugCameraRotation.yaw = Math.atan2(-dir.x, -dir.z);
  debugCameraRotation.pitch = Math.asin(dir.y);

  debugCameraEnabled = true;
  debugKeysPressed = {};

  // Add event listeners
  document.addEventListener('keydown', handleDebugKeyDown);
  document.addEventListener('keyup', handleDebugKeyUp);
  renderer.domElement.addEventListener('mousedown', handleDebugMouseDown);
  document.addEventListener('mouseup', handleDebugMouseUp);
  document.addEventListener('mousemove', handleDebugMouseMove);

  // Show room mesh wireframe in debug mode
  setRoomMeshVisible(true);

  console.log('Debug camera enabled - WASD to move, mouse to look, Space/Ctrl for up/down');
}

/**
 * Disable debug camera mode - restore original camera state.
 */
export function disableDebugCamera() {
  if (!debugCameraEnabled) return;

  // Restore camera state
  if (savedCameraState) {
    camera.position.copy(savedCameraState.position);
    camera.rotation.copy(savedCameraState.rotation);
    camera.fov = savedCameraState.fov;
    camera.updateProjectionMatrix();
  }

  debugCameraEnabled = false;
  debugKeysPressed = {};
  savedCameraState = null;

  // Remove event listeners
  document.removeEventListener('keydown', handleDebugKeyDown);
  document.removeEventListener('keyup', handleDebugKeyUp);
  renderer.domElement.removeEventListener('mousedown', handleDebugMouseDown);
  document.removeEventListener('mouseup', handleDebugMouseUp);
  document.removeEventListener('mousemove', handleDebugMouseMove);

  // Hide room mesh wireframe
  setRoomMeshVisible(false);

  console.log('Debug camera disabled - camera restored');
}

function handleDebugKeyDown(e) {
  debugKeysPressed[e.code] = true;
}

function handleDebugKeyUp(e) {
  debugKeysPressed[e.code] = false;
}

function handleDebugMouseDown(e) {
  if (e.button === 0) { // Left click
    debugMouseDown = true;
    debugLastMouseX = e.clientX;
    debugLastMouseY = e.clientY;
  }
}

function handleDebugMouseUp(e) {
  if (e.button === 0) {
    debugMouseDown = false;
  }
}

function handleDebugMouseMove(e) {
  if (!debugMouseDown || !debugCameraEnabled) return;

  const deltaX = e.clientX - debugLastMouseX;
  const deltaY = e.clientY - debugLastMouseY;
  debugLastMouseX = e.clientX;
  debugLastMouseY = e.clientY;

  // Adjust rotation (sensitivity)
  const sensitivity = 0.003;
  debugCameraRotation.yaw -= deltaX * sensitivity;
  debugCameraRotation.pitch -= deltaY * sensitivity;

  // Clamp pitch to avoid flipping
  debugCameraRotation.pitch = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, debugCameraRotation.pitch));

  // Apply rotation to camera
  updateDebugCameraRotation();
}

function updateDebugCameraRotation() {
  if (!camera) return;

  // Create rotation from yaw and pitch
  const euler = new THREE.Euler(debugCameraRotation.pitch, debugCameraRotation.yaw, 0, 'YXZ');
  camera.rotation.copy(euler);
}

/**
 * Update debug camera movement - call this in animation loop.
 */
export function updateDebugCamera(deltaTime = 0.016) {
  if (!debugCameraEnabled || !camera) return;

  const speed = 2.0; // units per second
  const moveSpeed = speed * deltaTime;

  // Get camera direction vectors
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  const right = new THREE.Vector3();
  right.crossVectors(forward, camera.up).normalize();

  // WASD movement
  if (debugKeysPressed['KeyW']) {
    camera.position.addScaledVector(forward, moveSpeed);
  }
  if (debugKeysPressed['KeyS']) {
    camera.position.addScaledVector(forward, -moveSpeed);
  }
  if (debugKeysPressed['KeyA']) {
    camera.position.addScaledVector(right, -moveSpeed);
  }
  if (debugKeysPressed['KeyD']) {
    camera.position.addScaledVector(right, moveSpeed);
  }

  // Up/Down with Space/Ctrl
  if (debugKeysPressed['Space']) {
    camera.position.y += moveSpeed;
  }
  if (debugKeysPressed['ControlLeft'] || debugKeysPressed['ControlRight']) {
    camera.position.y -= moveSpeed;
  }

  // Shift for faster movement
  if (debugKeysPressed['ShiftLeft'] || debugKeysPressed['ShiftRight']) {
    // Already moved, so move again for 2x speed
    if (debugKeysPressed['KeyW']) camera.position.addScaledVector(forward, moveSpeed);
    if (debugKeysPressed['KeyS']) camera.position.addScaledVector(forward, -moveSpeed);
    if (debugKeysPressed['KeyA']) camera.position.addScaledVector(right, -moveSpeed);
    if (debugKeysPressed['KeyD']) camera.position.addScaledVector(right, moveSpeed);
    if (debugKeysPressed['Space']) camera.position.y += moveSpeed;
    if (debugKeysPressed['ControlLeft'] || debugKeysPressed['ControlRight']) camera.position.y -= moveSpeed;
  }
}

// Update camera FOV (used when MoGe-2 provides estimated FOV)
export function setCameraFov(fov) {
  if (camera && fov > 0 && fov < 180) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
    console.log(`Camera FOV updated to ${fov}°`);
  }
}

/**
 * Set camera to MoGe-aligned position (at origin, looking into scene).
 * This is required for the point cloud to align with the background image.
 * Also locks aspect ratio to maintain alignment during resize.
 * @param {number} fov - Vertical field of view in degrees
 * @param {number} imageAspect - Image aspect ratio (width/height) for pixel-perfect alignment
 */
export function setCameraForMoGeAlignment(fov, imageAspect) {
  if (!camera) return;

  // MoGe outputs in OpenCV convention: X-right, Y-down, Z-forward (positive)
  // After scale(1, -1, -1): points at (x, -y, -z) - now at negative Z
  // Camera at origin must look at -Z to see them
  camera.position.set(0, 0, 0);
  camera.rotation.set(0, 0, 0);
  camera.lookAt(0, 0, -1); // Look into -Z where transformed points are

  if (fov > 0 && fov < 180) {
    camera.fov = fov;
  }

  // Lock aspect ratio for pixel-perfect alignment
  // This enables letterboxing/pillarboxing during resize
  if (imageAspect && imageAspect > 0) {
    lockAspectRatio(imageAspect);
  }

  camera.updateProjectionMatrix();

  console.log('Camera aligned for MoGe:', {
    fov: camera.fov,
    aspect: camera.aspect.toFixed(3),
    position: camera.position.toArray(),
    aspectLocked: isAspectRatioLocked()
  });
}

/**
 * Set the background image as a 3D plane in the scene.
 * The plane is sized to fill the viewport exactly at the given depth.
 * This ensures pixel-perfect alignment between the image and point cloud.
 * @param {Blob|string} imageSource - The room image as a Blob or URL string
 * @param {number} depth - Distance from camera (positive value, will be placed at -depth Z)
 * @returns {Promise<THREE.Mesh>} The background plane mesh
 */
export async function setBackgroundImagePlane(imageSource, depth = 10) {
  if (!scene || !camera) {
    throw new Error('Scene not initialized');
  }

  // Remove existing background plane if any
  if (backgroundImagePlane) {
    scene.remove(backgroundImagePlane);
    backgroundImagePlane = null;
  }
  if (backgroundImageTexture) {
    backgroundImageTexture.dispose();
    backgroundImageTexture = null;
  }

  // Handle both Blob and URL string inputs
  let imageUrl;
  let shouldRevokeUrl = false;
  if (imageSource instanceof Blob) {
    imageUrl = URL.createObjectURL(imageSource);
    shouldRevokeUrl = true;
  } else if (typeof imageSource === 'string') {
    imageUrl = imageSource;
  } else {
    throw new Error('imageSource must be a Blob or URL string');
  }

  return new Promise((resolve, reject) => {
    // Load the image to get its dimensions
    const img = new Image();
    img.onload = () => {
      const imageAspect = img.width / img.height;

      // Load as Three.js texture
      const textureLoader = new THREE.TextureLoader();
      textureLoader.load(
        imageUrl,
        (texture) => {
          if (shouldRevokeUrl) URL.revokeObjectURL(imageUrl);
          backgroundImageTexture = texture;

          // Ensure texture is not repeated and uses linear filtering for quality
          texture.wrapS = THREE.ClampToEdgeWrapping;
          texture.wrapT = THREE.ClampToEdgeWrapping;
          texture.minFilter = THREE.LinearFilter;
          texture.magFilter = THREE.LinearFilter;
          // Set color space to sRGB so colors display correctly (not affected by lighting)
          texture.colorSpace = THREE.SRGBColorSpace;

          // Calculate plane size to fill viewport at the given depth
          // visibleHeight = 2 * tan(fov/2) * distance
          const fovRad = camera.fov * Math.PI / 180;
          const visibleHeight = 2 * Math.tan(fovRad / 2) * depth;
          const visibleWidth = visibleHeight * camera.aspect;

          // Use the image aspect ratio for the plane
          // If camera aspect doesn't match image aspect, we need to decide how to handle it
          // For pixel-perfect alignment, the plane should match the image dimensions
          let planeWidth, planeHeight;

          if (camera.aspect > imageAspect) {
            // Camera is wider than image - match height, image will have black bars on sides
            planeHeight = visibleHeight;
            planeWidth = planeHeight * imageAspect;
          } else {
            // Camera is taller than image - match width, image will have black bars top/bottom
            planeWidth = visibleWidth;
            planeHeight = planeWidth / imageAspect;
          }

          // Create plane geometry
          const geometry = new THREE.PlaneGeometry(planeWidth, planeHeight);

          // Create material - unlit so it looks like a background
          const material = new THREE.MeshBasicMaterial({
            map: texture,
            side: THREE.FrontSide,
            depthWrite: true,
            depthTest: true,
            toneMapped: false  // Don't apply tone mapping - display image as-is
          });

          // Create mesh
          backgroundImagePlane = new THREE.Mesh(geometry, material);

          // Position at -Z (in front of camera which looks at -Z)
          // The plane faces +Z (towards camera)
          backgroundImagePlane.position.set(0, 0, -depth);

          // Add to scene (at beginning so it renders behind everything)
          scene.add(backgroundImagePlane);

          // Move to back of render order
          backgroundImagePlane.renderOrder = -1;

          console.log('Background image plane created:', {
            depth: depth,
            planeSize: [planeWidth.toFixed(2), planeHeight.toFixed(2)],
            imageSize: [img.width, img.height],
            imageAspect: imageAspect.toFixed(3),
            cameraAspect: camera.aspect.toFixed(3),
            visibleArea: [visibleWidth.toFixed(2), visibleHeight.toFixed(2)]
          });

          resolve(backgroundImagePlane);
        },
        undefined,
        (error) => {
          if (shouldRevokeUrl) URL.revokeObjectURL(imageUrl);
          reject(error);
        }
      );
    };
    img.onerror = () => {
      if (shouldRevokeUrl) URL.revokeObjectURL(imageUrl);
      reject(new Error('Failed to load image'));
    };
    img.src = imageUrl;
  });
}

/**
 * Update background plane size when camera FOV or aspect changes.
 * Call this after changing camera FOV or on window resize.
 */
export function updateBackgroundPlaneSize() {
  if (!backgroundImagePlane || !camera || !backgroundImageTexture) return;

  const depth = Math.abs(backgroundImagePlane.position.z);
  const imageAspect = backgroundImageTexture.image.width / backgroundImageTexture.image.height;

  // Calculate visible area at plane depth
  const fovRad = camera.fov * Math.PI / 180;
  const visibleHeight = 2 * Math.tan(fovRad / 2) * depth;
  const visibleWidth = visibleHeight * camera.aspect;

  let planeWidth, planeHeight;

  // When aspect ratio is locked, camera.aspect === imageAspect
  // so plane fills the entire viewport perfectly
  if (lockedImageAspect && Math.abs(camera.aspect - imageAspect) < 0.001) {
    // Perfect match - fill viewport
    planeWidth = visibleWidth;
    planeHeight = visibleHeight;
  } else {
    // Mismatch - apply letterbox/pillarbox to plane
    if (camera.aspect > imageAspect) {
      planeHeight = visibleHeight;
      planeWidth = planeHeight * imageAspect;
    } else {
      planeWidth = visibleWidth;
      planeHeight = planeWidth / imageAspect;
    }
  }

  // Update geometry
  backgroundImagePlane.geometry.dispose();
  backgroundImagePlane.geometry = new THREE.PlaneGeometry(planeWidth, planeHeight);

  console.log('Background plane size updated:', {
    planeSize: [planeWidth.toFixed(2), planeHeight.toFixed(2)],
    locked: !!lockedImageAspect
  });
}

/**
 * Remove the background image plane from the scene.
 */
export function clearBackgroundImagePlane() {
  if (backgroundImagePlane) {
    scene.remove(backgroundImagePlane);
    if (backgroundImagePlane.geometry) backgroundImagePlane.geometry.dispose();
    if (backgroundImagePlane.material) backgroundImagePlane.material.dispose();
    backgroundImagePlane = null;
  }
  if (backgroundImageTexture) {
    backgroundImageTexture.dispose();
    backgroundImageTexture = null;
  }
}

// ============ Aspect Ratio Locking ============

/**
 * Lock the scene to a specific image aspect ratio.
 * When locked, resize events maintain this aspect ratio with letterboxing.
 * @param {number} imageAspect - Width/height ratio to lock to (must be valid positive number)
 * @throws {Error} If imageAspect is not a valid positive number
 */
export function lockAspectRatio(imageAspect) {
  if (typeof imageAspect !== 'number' || !isFinite(imageAspect) || imageAspect <= 0) {
    throw new Error(`Invalid imageAspect: ${imageAspect}. Must be a positive number.`);
  }

  lockedImageAspect = imageAspect;
  console.log('Aspect ratio locked to:', imageAspect.toFixed(3));

  // Apply immediately
  applyAspectRatioResize();
}

/**
 * Unlock the aspect ratio, returning to full-window mode.
 * Used when clearing room or returning to default state.
 */
export function unlockAspectRatio() {
  lockedImageAspect = null;
  console.log('Aspect ratio unlocked');

  // Return to full window mode
  const container = document.getElementById('canvas-container');
  container.style.width = '100%';
  container.style.height = '100%';
  container.style.left = '0';
  container.style.top = '0';

  // Reset camera to window aspect
  if (camera && renderer) {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
}

/**
 * Check if aspect ratio is currently locked.
 * @returns {boolean}
 */
export function isAspectRatioLocked() {
  return lockedImageAspect !== null;
}

/**
 * Get the currently locked aspect ratio.
 * @returns {number|null}
 */
export function getLockedAspectRatio() {
  return lockedImageAspect;
}

/**
 * Apply letterbox/pillarbox sizing to maintain locked aspect ratio.
 * Called on window resize when aspect ratio is locked.
 */
function applyAspectRatioResize() {
  if (!lockedImageAspect || !camera || !renderer) return;

  const container = document.getElementById('canvas-container');
  const windowWidth = window.innerWidth;
  const windowHeight = window.innerHeight;
  const windowAspect = windowWidth / windowHeight;

  let canvasWidth, canvasHeight, offsetX, offsetY;

  if (windowAspect > lockedImageAspect) {
    // Window is wider than image - pillarbox (black bars on sides)
    canvasHeight = windowHeight;
    canvasWidth = windowHeight * lockedImageAspect;
    offsetX = (windowWidth - canvasWidth) / 2;
    offsetY = 0;
  } else {
    // Window is taller than image - letterbox (black bars top/bottom)
    canvasWidth = windowWidth;
    canvasHeight = windowWidth / lockedImageAspect;
    offsetX = 0;
    offsetY = (windowHeight - canvasHeight) / 2;
  }

  // Update container position and size
  container.style.width = `${canvasWidth}px`;
  container.style.height = `${canvasHeight}px`;
  container.style.left = `${offsetX}px`;
  container.style.top = `${offsetY}px`;

  // Update renderer to match container
  renderer.setSize(canvasWidth, canvasHeight);

  // Camera aspect matches image aspect (always)
  camera.aspect = lockedImageAspect;
  camera.updateProjectionMatrix();

  // Update background plane for new dimensions
  updateBackgroundPlaneSize();

  console.log('Aspect ratio resize applied:', {
    window: [windowWidth, windowHeight],
    canvas: [canvasWidth.toFixed(0), canvasHeight.toFixed(0)],
    offset: [offsetX.toFixed(0), offsetY.toFixed(0)],
    imageAspect: lockedImageAspect.toFixed(3)
  });
}

/**
 * Load room geometry from MoGe-2 mesh URL.
 * The mesh is used for furniture placement raycasting and is invisible by default.
 * A wireframe version is created for debug visualization.
 * @param {string} meshUrl - URL to the mesh GLB
 * @param {Object} options - Loading options
 * @returns {Promise<Object>} Room dimensions and mesh references
 */
export async function loadRoomGeometry(meshUrl, options = {}) {
  const {
    wireframeColor = 0x00ff00,
    wireframeOpacity = 0.5
  } = options;

  // Adjust URL for proxy prefix (e.g., /api/... -> /room/api/...)
  const adjustedUrl = adjustUrlForProxy(meshUrl);
  console.log('Loading room mesh from:', adjustedUrl);

  return new Promise((resolve, reject) => {
    gltfLoader.load(
      adjustedUrl,
      (gltf) => {
        const model = gltf.scene;

        // MoGe mesh is already in correct coordinate system
        model.scale.set(1, 1, 1);

        // Calculate bounding box
        const box = new THREE.Box3().setFromObject(model);
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        box.getSize(size);
        box.getCenter(center);

        console.log('Room mesh loaded:', {
          min: box.min.toArray(),
          max: box.max.toArray(),
          size: size.toArray(),
          center: center.toArray()
        });

        // Update global room bounds
        roomBounds.copy(box);

        // Remove old room geometry if exists
        if (roomMesh) {
          scene.remove(roomMesh);
          roomMesh = null;
        }
        if (roomMeshWireframe) {
          scene.remove(roomMeshWireframe);
          roomMeshWireframe = null;
        }
        if (roomGeometryModel) {
          scene.remove(roomGeometryModel);
          roomGeometryModel = null;
        }

        // Hide default room visuals
        if (roomWireframe) roomWireframe.visible = false;
        if (floor) floor.visible = false;

        // Create mesh for raycasting and shadow receiving
        // ShadowMaterial is invisible except where shadows fall
        // renderOrder = -1 ensures shadow-receiving mesh renders before casters
        roomMesh = model.clone();
        roomMesh.traverse((child) => {
          if (child.isMesh) {
            child.material = new THREE.ShadowMaterial({
              opacity: 0.5,
              side: THREE.FrontSide
            });
            child.receiveShadow = true;
            child.renderOrder = -1;
          }
        });
        scene.add(roomMesh);

        // Create wireframe version for debug visualization (hidden by default)
        roomMeshWireframe = model.clone();
        roomMeshWireframe.visible = false;
        roomMeshWireframe.traverse((child) => {
          if (child.isMesh) {
            child.material = new THREE.MeshBasicMaterial({
              color: wireframeColor,
              wireframe: true,
              transparent: true,
              opacity: wireframeOpacity,
              side: THREE.DoubleSide,
              depthTest: true,
              depthWrite: false
            });
          }
        });
        scene.add(roomMeshWireframe);

        console.log('Room mesh ready - shadow-receiving for raycasting, wireframe available for debug');

        // Update shadow camera to encompass room bounds
        updateShadowCamera(box);

        resolve({
          mesh: roomMesh,
          wireframe: roomMeshWireframe,
          bounds: box,
          size: { width: size.x, height: size.y, depth: size.z },
          center: { x: center.x, y: center.y, z: center.z }
        });
      },
      (progress) => {
        const percent = progress.total > 0
          ? (progress.loaded / progress.total * 100).toFixed(1)
          : 'unknown';
        console.log('Loading room mesh:', percent + '%');
      },
      (error) => {
        console.error('Error loading room mesh:', error);
        reject(error);
      }
    );
  });
}

/**
 * Update room visual elements (floor and wireframe) to match bounds.
 * @param {THREE.Box3} bounds - New room bounds
 */
function updateRoomVisuals(bounds) {
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  bounds.getSize(size);
  bounds.getCenter(center);

  // Update floor size and position
  if (floor) {
    floor.geometry.dispose();
    floor.geometry = new THREE.PlaneGeometry(size.x, size.z);
    floor.position.set(center.x, bounds.min.y, center.z);
  }

  // Update room wireframe
  if (roomWireframe) {
    scene.remove(roomWireframe);

    const roomGeometry = new THREE.BoxGeometry(size.x, size.y, size.z);
    const roomEdges = new THREE.EdgesGeometry(roomGeometry);
    roomWireframe = new THREE.LineSegments(
      roomEdges,
      new THREE.LineBasicMaterial({ color: 0x4f46e5, opacity: 0.5, transparent: true })
    );
    roomWireframe.position.copy(center);
    scene.add(roomWireframe);
  }

  console.log('Room visuals updated to bounds:', {
    min: bounds.min.toArray(),
    max: bounds.max.toArray()
  });
}

/**
 * Clear room geometry (revert to default cube).
 */
export function clearRoomGeometry() {
  // Clear mesh for raycasting
  if (roomMesh) {
    scene.remove(roomMesh);
    roomMesh = null;
  }

  // Clear wireframe for debug
  if (roomMeshWireframe) {
    scene.remove(roomMeshWireframe);
    roomMeshWireframe = null;
  }

  // Clear legacy point cloud model if exists
  if (roomGeometryModel) {
    scene.remove(roomGeometryModel);
    roomGeometryModel = null;
  }

  // Clear background image plane as well
  clearBackgroundImagePlane();

  // Unlock aspect ratio - return to full window mode
  unlockAspectRatio();

  // Reset to default bounds
  roomBounds.set(
    new THREE.Vector3(-5, 0, -5),
    new THREE.Vector3(5, 4, 5)
  );

  // Show default room visuals again
  if (roomWireframe) {
    roomWireframe.visible = true;
  }
  if (floor) {
    floor.visible = true;
  }

  // Reset camera to default position
  if (camera) {
    camera.position.set(0, 5, 10);
    camera.lookAt(0, 0, 0);
    camera.fov = 60;
    camera.updateProjectionMatrix();
  }
}

// Initialize the Three.js scene
export function initScene() {
  const container = document.getElementById('canvas-container');

  // Scene with no background (transparent)
  scene = new THREE.Scene();

  // Camera - perspective camera looking at the room
  camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );
  camera.position.set(0, 5, 10);
  camera.lookAt(0, 0, 0);

  // Renderer with transparency
  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true
  });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  // Prevent default touch behaviors on canvas (scrolling, zooming)
  renderer.domElement.style.touchAction = 'none';

  // Lighting
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambientLight);

  directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
  directionalLight.position.set(5, 10, 7.5);
  directionalLight.castShadow = true;
  directionalLight.shadow.mapSize.width = 2048;
  directionalLight.shadow.mapSize.height = 2048;
  directionalLight.shadow.camera.near = 0.5;
  directionalLight.shadow.camera.far = 50;
  directionalLight.shadow.camera.left = -10;
  directionalLight.shadow.camera.right = 10;
  directionalLight.shadow.camera.top = 10;
  directionalLight.shadow.camera.bottom = -10;
  directionalLight.shadow.bias = -0.0005; // Reduce shadow acne
  directionalLight.shadow.normalBias = 0.02; // Help with shadow visibility on angled surfaces
  scene.add(directionalLight);
  // Add target to scene so light direction works properly
  scene.add(directionalLight.target);

  // Create default cube room
  createDefaultRoom();

  // Transform controls for furniture manipulation
  transformControls = new TransformControls(camera, renderer.domElement);
  transformControls.setSpace('world');
  scene.add(transformControls);

  // GLB/GLTF Loader (Three.js uses same loader for both formats)
  gltfLoader = new GLTFLoader();

  // Handle window resize
  window.addEventListener('resize', onWindowResize);

  // Animation loop
  renderer.setAnimationLoop(animate);

  return { scene, camera, renderer, transformControls };
}

// Create default cube room geometry
function createDefaultRoom() {
  // Semi-transparent floor
  const floorGeometry = new THREE.PlaneGeometry(10, 10);
  const floorMaterial = new THREE.MeshStandardMaterial({
    color: 0x808080,
    transparent: true,
    opacity: 0.3,
    side: THREE.DoubleSide
  });
  floor = new THREE.Mesh(floorGeometry, floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0;
  floor.receiveShadow = true;
  floor.userData.isFloor = true;
  scene.add(floor);

  // Room wireframe box to show boundaries
  const roomGeometry = new THREE.BoxGeometry(10, 4, 10);
  const roomEdges = new THREE.EdgesGeometry(roomGeometry);
  roomWireframe = new THREE.LineSegments(
    roomEdges,
    new THREE.LineBasicMaterial({ color: 0x4f46e5, opacity: 0.5, transparent: true })
  );
  roomWireframe.position.y = 2;
  scene.add(roomWireframe);
}

// Animation loop
function animate() {
  // Update debug camera if enabled
  updateDebugCamera();

  renderer.render(scene, camera);
}

// Handle window resize
function onWindowResize() {
  if (lockedImageAspect) {
    // Maintain locked aspect ratio with letterboxing
    applyAspectRatioResize();
  } else {
    // Default: full window mode
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);

    // Update background plane to match new viewport size
    updateBackgroundPlaneSize();
  }
}

// Load model from Blob (GLB only)
async function loadModelFromBlob(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const gltf = await gltfLoader.loadAsync(url);
    const model = gltf.scene;

    // Enable shadows on all meshes
    model.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });

    return model;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Load model from extracted ZIP data (GLB only)
export async function loadModelFromExtractedZip(extractedData) {
  return loadModelFromBlob(extractedData.modelBlob);
}

// Update mouse coordinates from event
function updateMouse(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
}

// Raycast to find furniture at mouse position
export function raycastFurniture(event) {
  updateMouse(event);
  raycaster.setFromCamera(mouse, camera);

  const intersects = raycaster.intersectObjects(selectableObjects, true);

  if (intersects.length > 0) {
    // Find the root furniture object
    let hitObject = intersects[0].object;
    while (hitObject.parent && hitObject.parent !== scene) {
      if (hitObject.userData.isFurniture) break;
      hitObject = hitObject.parent;
    }
    return {
      object: hitObject.userData.isFurniture ? hitObject : findFurnitureRoot(hitObject),
      point: intersects[0].point
    };
  }
  return null;
}

// Find the furniture root from a child mesh
function findFurnitureRoot(object) {
  let current = object;
  while (current.parent && current.parent !== scene) {
    if (current.userData.isFurniture) return current;
    current = current.parent;
  }
  return current.userData.isFurniture ? current : null;
}

// Raycast to floor for dragging
export function raycastFloor(event) {
  updateMouse(event);
  raycaster.setFromCamera(mouse, camera);

  const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const intersectPoint = new THREE.Vector3();
  raycaster.ray.intersectPlane(floorPlane, intersectPoint);

  return intersectPoint;
}

// Add furniture to scene
export function addFurnitureToScene(model, entryId, position) {
  model.userData.isFurniture = true;
  model.userData.entryId = entryId;
  model.userData.isDraggable = true;

  if (position) {
    model.position.copy(position);
  }

  scene.add(model);
  selectableObjects.push(model);

  return model;
}

// Remove furniture from scene
export function removeFurnitureFromScene(model) {
  scene.remove(model);
  const index = selectableObjects.indexOf(model);
  if (index > -1) {
    selectableObjects.splice(index, 1);
  }

  // Detach transform controls if attached to this model
  if (transformControls.object === model) {
    transformControls.detach();
  }
}

// Remove all furniture with a specific entry ID
export function removeFurnitureByEntryId(entryId) {
  const toRemove = selectableObjects.filter(obj => obj.userData.entryId === entryId);
  toRemove.forEach(obj => removeFurnitureFromScene(obj));
  return toRemove.length;
}

// Clear all furniture from scene
export function clearAllFurniture() {
  const toRemove = [...selectableObjects];
  toRemove.forEach(obj => removeFurnitureFromScene(obj));
}

// Generate 3D preview image from an already-loaded Three.js model (client-side, unused - server generates previews)
export async function generatePreview3dFromModel(model, width = 256, height = 256) {
  // Create offscreen renderer
  const offscreenRenderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true
  });
  offscreenRenderer.setSize(width, height);
  offscreenRenderer.setClearColor(0x000000, 0);

  // Create scene
  const offscreenScene = new THREE.Scene();

  // Create camera
  const offscreenCamera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000);

  // Add lighting
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  offscreenScene.add(ambientLight);
  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
  directionalLight.position.set(5, 10, 7.5);
  offscreenScene.add(directionalLight);

  // Clone the model so we don't affect the original
  const modelClone = model.clone();
  offscreenScene.add(modelClone);

  // Center and fit model in view
  const box = new THREE.Box3().setFromObject(modelClone);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());

  // Move model to center
  modelClone.position.sub(center);

  // Position camera to fit model tightly in frame
  const maxDim = Math.max(size.x, size.y, size.z);
  const fov = offscreenCamera.fov * (Math.PI / 180);
  const cameraDistance = maxDim / (2 * Math.tan(fov / 2)) * 1.0;

  offscreenCamera.position.set(cameraDistance * 0.8, cameraDistance * 0.5, cameraDistance * 0.8);
  offscreenCamera.lookAt(0, 0, 0);

  // Render
  offscreenRenderer.render(offscreenScene, offscreenCamera);

  // Get image as data URL
  const dataUrl = offscreenRenderer.domElement.toDataURL('image/png');

  // Convert to Blob
  const response = await fetch(dataUrl);
  const blob = await response.blob();

  // Cleanup
  offscreenRenderer.dispose();

  return blob;
}

// Calculate furniture scale based on entry dimensions
export function calculateFurnitureScale(model, entry) {
  const { dimensionX, dimensionY, dimensionZ } = entry;

  // Get model bounding box in local units
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());

  const dims = [dimensionX, dimensionY, dimensionZ];
  const filledDims = dims.filter(d => d !== null && d !== undefined);

  if (filledDims.length === 0) {
    // No scaling - use default
    return new THREE.Vector3(1, 1, 1);
  }

  if (filledDims.length === 1) {
    // Uniform scaling based on single reference dimension
    let scaleFactor = 1;

    if (dimensionX !== null && dimensionX !== undefined && size.x > 0) {
      scaleFactor = dimensionX / size.x;
    } else if (dimensionY !== null && dimensionY !== undefined && size.y > 0) {
      scaleFactor = dimensionY / size.y;
    } else if (dimensionZ !== null && dimensionZ !== undefined && size.z > 0) {
      scaleFactor = dimensionZ / size.z;
    }

    return new THREE.Vector3(scaleFactor, scaleFactor, scaleFactor);
  }

  if (filledDims.length === 3) {
    // Non-uniform scaling (morph)
    return new THREE.Vector3(
      size.x > 0 ? dimensionX / size.x : 1,
      size.y > 0 ? dimensionY / size.y : 1,
      size.z > 0 ? dimensionZ / size.z : 1
    );
  }

  // Should never reach here (validation prevents 2 dimensions)
  return new THREE.Vector3(1, 1, 1);
}

// Collect placed furniture state for saving
export function collectPlacedFurniture() {
  const placedFurniture = [];

  selectableObjects.forEach((object) => {
    if (object.userData.isFurniture && object.userData.entryId) {
      const data = {
        entryId: object.userData.entryId,
        position: {
          x: object.position.x,
          y: object.position.y,
          z: object.position.z
        },
        rotation: {
          x: object.rotation.x,
          y: object.rotation.y,
          z: object.rotation.z
        },
        scale: {
          x: object.scale.x,
          y: object.scale.y,
          z: object.scale.z
        }
      };

      // Save surface orientation data
      if (object.userData.surfaceNormal) {
        data.surfaceNormal = {
          x: object.userData.surfaceNormal.x,
          y: object.userData.surfaceNormal.y,
          z: object.userData.surfaceNormal.z
        };
      }

      if (object.userData.contactAxis) {
        data.contactAxis = {
          x: object.userData.contactAxis.x,
          y: object.userData.contactAxis.y,
          z: object.userData.contactAxis.z
        };
      }

      if (typeof object.userData.uprightRotation === 'number') {
        data.uprightRotation = object.userData.uprightRotation;
      }

      if (typeof object.userData.rotationAroundNormal === 'number') {
        data.rotationAroundNormal = object.userData.rotationAroundNormal;
      }

      // Save base scale for room scale recalculation on load
      if (object.userData.baseScale) {
        data.baseScale = {
          x: object.userData.baseScale.x,
          y: object.userData.baseScale.y,
          z: object.userData.baseScale.z
        };
      }

      placedFurniture.push(data);
    }
  });

  return placedFurniture;
}

// ============ Lighting Controls ============

/**
 * Update shadow camera frustum to encompass the given bounds.
 * Called when room mesh loads to ensure shadows aren't clipped.
 * @param {THREE.Box3} bounds - Scene bounds to encompass
 */
function updateShadowCamera(bounds) {
  if (!directionalLight || !bounds) return;

  const size = bounds.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) * 1.5;

  // Expand shadow camera frustum to cover room bounds
  directionalLight.shadow.camera.left = -maxDim;
  directionalLight.shadow.camera.right = maxDim;
  directionalLight.shadow.camera.top = maxDim;
  directionalLight.shadow.camera.bottom = -maxDim;
  directionalLight.shadow.camera.far = maxDim * 3;
  directionalLight.shadow.camera.updateProjectionMatrix();

  console.log('Shadow camera frustum expanded:', maxDim.toFixed(2));
}

/**
 * Get the directional light for external control.
 * @returns {THREE.DirectionalLight|null}
 */
export function getDirectionalLight() {
  return directionalLight;
}

/**
 * Set the intensity of the directional light.
 * @param {number} intensity - Light intensity (0 to max)
 */
export function setLightIntensity(intensity) {
  if (directionalLight) {
    directionalLight.intensity = Math.max(0, intensity);
  }
}

/**
 * Set the direction of the directional light by specifying source position and target.
 * @param {THREE.Vector3} position - Light source position
 * @param {THREE.Vector3} target - Target position the light points at
 */
export function setLightDirection(position, target) {
  if (directionalLight) {
    directionalLight.position.copy(position);
    directionalLight.target.position.copy(target);
    directionalLight.target.updateMatrixWorld();
  }
}

/**
 * Convert color temperature in Kelvin to RGB color.
 * Based on algorithm by Tanner Helland.
 * @param {number} kelvin - Color temperature (1000K to 40000K)
 * @returns {THREE.Color} - RGB color
 */
function kelvinToRGB(kelvin) {
  const temp = kelvin / 100;
  let r, g, b;

  // Calculate red
  if (temp <= 66) {
    r = 255;
  } else {
    r = temp - 60;
    r = 329.698727446 * Math.pow(r, -0.1332047592);
    r = Math.max(0, Math.min(255, r));
  }

  // Calculate green
  if (temp <= 66) {
    g = temp;
    g = 99.4708025861 * Math.log(g) - 161.1195681661;
    g = Math.max(0, Math.min(255, g));
  } else {
    g = temp - 60;
    g = 288.1221695283 * Math.pow(g, -0.0755148492);
    g = Math.max(0, Math.min(255, g));
  }

  // Calculate blue
  if (temp >= 66) {
    b = 255;
  } else if (temp <= 19) {
    b = 0;
  } else {
    b = temp - 10;
    b = 138.5177312231 * Math.log(b) - 305.0447927307;
    b = Math.max(0, Math.min(255, b));
  }

  return new THREE.Color(r / 255, g / 255, b / 255);
}

/**
 * Set the color temperature of the directional light.
 * @param {number} kelvin - Color temperature in Kelvin (2000-10000 typical)
 */
export function setLightTemperature(kelvin) {
  if (directionalLight) {
    const color = kelvinToRGB(kelvin);
    directionalLight.color.copy(color);
  }
}

// ============ Lighting Gizmo ============

const GIZMO_SOURCE_COLOR = 0xffaa00;  // Orange for light source
const GIZMO_TARGET_COLOR = 0x00aaff;  // Blue for target
const GIZMO_LINE_COLOR = 0xffff00;    // Yellow for line
const GIZMO_SPHERE_RADIUS = 0.15;
const GIZMO_HOVER_SCALE = 1.3;

/**
 * Create the lighting direction gizmo if it doesn't exist.
 */
function createLightingGizmo() {
  if (lightingGizmo) return;

  lightingGizmo = new THREE.Group();
  lightingGizmo.name = 'lightingGizmo';
  lightingGizmo.visible = false;

  // Source sphere (where light originates)
  const sourceGeom = new THREE.SphereGeometry(GIZMO_SPHERE_RADIUS, 16, 16);
  const sourceMat = new THREE.MeshBasicMaterial({
    color: GIZMO_SOURCE_COLOR,
    transparent: true,
    opacity: 0.9,
    depthTest: false
  });
  lightingGizmoSource = new THREE.Mesh(sourceGeom, sourceMat);
  lightingGizmoSource.renderOrder = 999;
  lightingGizmoSource.userData.isLightingGizmo = true;
  lightingGizmoSource.userData.gizmoType = 'source';
  lightingGizmo.add(lightingGizmoSource);

  // Target sphere (where light points to)
  const targetGeom = new THREE.SphereGeometry(GIZMO_SPHERE_RADIUS, 16, 16);
  const targetMat = new THREE.MeshBasicMaterial({
    color: GIZMO_TARGET_COLOR,
    transparent: true,
    opacity: 0.9,
    depthTest: false
  });
  lightingGizmoTarget = new THREE.Mesh(targetGeom, targetMat);
  lightingGizmoTarget.renderOrder = 999;
  lightingGizmoTarget.userData.isLightingGizmo = true;
  lightingGizmoTarget.userData.gizmoType = 'target';
  lightingGizmo.add(lightingGizmoTarget);

  // Line connecting source to target
  const lineGeom = new THREE.BufferGeometry();
  const positions = new Float32Array(6); // 2 points * 3 components
  lineGeom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const lineMat = new THREE.LineBasicMaterial({
    color: GIZMO_LINE_COLOR,
    linewidth: 2,
    depthTest: false
  });
  lightingGizmoLine = new THREE.Line(lineGeom, lineMat);
  lightingGizmoLine.renderOrder = 998;
  lightingGizmo.add(lightingGizmoLine);

  // Arrow head (cone pointing in light direction)
  const arrowGeom = new THREE.ConeGeometry(0.1, 0.25, 8);
  const arrowMat = new THREE.MeshBasicMaterial({
    color: GIZMO_LINE_COLOR,
    transparent: true,
    opacity: 0.9,
    depthTest: false
  });
  lightingGizmoArrow = new THREE.Mesh(arrowGeom, arrowMat);
  lightingGizmoArrow.renderOrder = 999;
  lightingGizmo.add(lightingGizmoArrow);

  scene.add(lightingGizmo);
}

/**
 * Update the lighting gizmo to match current light position/target.
 */
export function updateLightingGizmo() {
  if (!lightingGizmo || !directionalLight) return;

  const sourcePos = directionalLight.position.clone();
  const targetPos = directionalLight.target.position.clone();

  // Update sphere positions
  lightingGizmoSource.position.copy(sourcePos);
  lightingGizmoTarget.position.copy(targetPos);

  // Update line
  const positions = lightingGizmoLine.geometry.attributes.position.array;
  positions[0] = sourcePos.x;
  positions[1] = sourcePos.y;
  positions[2] = sourcePos.z;
  positions[3] = targetPos.x;
  positions[4] = targetPos.y;
  positions[5] = targetPos.z;
  lightingGizmoLine.geometry.attributes.position.needsUpdate = true;

  // Update arrow position and rotation
  // Position arrow at 70% from source to target
  const direction = new THREE.Vector3().subVectors(targetPos, sourcePos);
  const length = direction.length();
  direction.normalize();

  const arrowPos = sourcePos.clone().add(direction.clone().multiplyScalar(length * 0.7));
  lightingGizmoArrow.position.copy(arrowPos);

  // Rotate arrow to point in light direction
  const quaternion = new THREE.Quaternion();
  quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  lightingGizmoArrow.quaternion.copy(quaternion);
}

/**
 * Show the lighting direction gizmo.
 */
export function showLightingGizmo() {
  createLightingGizmo();
  updateLightingGizmo();
  lightingGizmo.visible = true;
}

/**
 * Hide the lighting direction gizmo.
 */
export function hideLightingGizmo() {
  if (lightingGizmo) {
    lightingGizmo.visible = false;
  }
}

/**
 * Check if the lighting gizmo is visible.
 * @returns {boolean}
 */
export function isLightingGizmoVisible() {
  return lightingGizmo && lightingGizmo.visible;
}

/**
 * Raycast to check if mouse is over a gizmo handle.
 * @param {MouseEvent} event - Mouse event
 * @returns {Object|null} - { type: 'source'|'target', object: mesh } or null
 */
export function raycastLightingGizmo(event) {
  if (!lightingGizmo || !lightingGizmo.visible) return null;

  updateMouse(event);
  raycaster.setFromCamera(mouse, camera);

  const handles = [lightingGizmoSource, lightingGizmoTarget];
  const intersects = raycaster.intersectObjects(handles, false);

  if (intersects.length > 0) {
    const hit = intersects[0];
    return {
      type: hit.object.userData.gizmoType,
      object: hit.object
    };
  }

  return null;
}

/**
 * Set hover state on a gizmo handle.
 * @param {string|null} handleType - 'source', 'target', or null to clear
 */
export function setLightingGizmoHover(handleType) {
  if (!lightingGizmo) return;

  // Reset scales
  lightingGizmoSource.scale.setScalar(1);
  lightingGizmoTarget.scale.setScalar(1);

  // Apply hover scale
  if (handleType === 'source') {
    lightingGizmoSource.scale.setScalar(GIZMO_HOVER_SCALE);
  } else if (handleType === 'target') {
    lightingGizmoTarget.scale.setScalar(GIZMO_HOVER_SCALE);
  }
}

/**
 * Get the current light source position.
 * @returns {THREE.Vector3}
 */
export function getLightPosition() {
  return directionalLight ? directionalLight.position.clone() : new THREE.Vector3(5, 10, 7.5);
}

/**
 * Get the current light target position.
 * @returns {THREE.Vector3}
 */
export function getLightTarget() {
  return directionalLight ? directionalLight.target.position.clone() : new THREE.Vector3(0, 0, 0);
}

/**
 * Set the light source position only (keeps target).
 * @param {THREE.Vector3} position
 */
export function setLightPosition(position) {
  if (directionalLight) {
    directionalLight.position.copy(position);
    updateLightingGizmo();
  }
}

/**
 * Set the light target position only (keeps source).
 * @param {THREE.Vector3} target
 */
export function setLightTargetPosition(target) {
  if (directionalLight) {
    directionalLight.target.position.copy(target);
    directionalLight.target.updateMatrixWorld();
    updateLightingGizmo();
  }
}

/**
 * Get current lighting settings for saving.
 * @returns {Object} Lighting settings
 */
export function getLightingSettings() {
  if (!directionalLight) return null;

  return {
    intensity: directionalLight.intensity,
    position: {
      x: directionalLight.position.x,
      y: directionalLight.position.y,
      z: directionalLight.position.z
    },
    target: {
      x: directionalLight.target.position.x,
      y: directionalLight.target.position.y,
      z: directionalLight.target.position.z
    },
    temperature: directionalLight.userData.temperature || 6500
  };
}

/**
 * Apply lighting settings from saved data.
 * @param {Object} settings - Lighting settings object
 */
export function applyLightingSettings(settings) {
  if (!directionalLight || !settings) return;

  if (typeof settings.intensity === 'number') {
    directionalLight.intensity = settings.intensity;
  }

  if (settings.position) {
    directionalLight.position.set(
      settings.position.x,
      settings.position.y,
      settings.position.z
    );
  }

  if (settings.target) {
    directionalLight.target.position.set(
      settings.target.x,
      settings.target.y,
      settings.target.z
    );
    directionalLight.target.updateMatrixWorld();
  }

  if (typeof settings.temperature === 'number') {
    directionalLight.userData.temperature = settings.temperature;
    const color = kelvinToRGB(settings.temperature);
    directionalLight.color.copy(color);
  }

  updateLightingGizmo();
}

// ============ Room Scale Controls ============

/**
 * Get the current room scale factor.
 * @returns {number} Current scale factor (default 1.0)
 */
export function getRoomScale() {
  return roomScaleFactor;
}

/**
 * Set the room-wide scale factor and apply to all furniture.
 * @param {number} scale - New scale factor (e.g., 0.5 to 2.0)
 */
export function setRoomScale(scale) {
  roomScaleFactor = Math.max(0.1, Math.min(5.0, scale)); // Clamp to reasonable range
  applyRoomScaleToAllFurniture();
}

/**
 * Apply the current room scale factor to all placed furniture.
 * Each furniture piece scales as: baseScale * roomScaleFactor (per component)
 */
export function applyRoomScaleToAllFurniture() {
  selectableObjects.forEach(obj => {
    if (obj.userData.isFurniture && obj.userData.baseScale) {
      // baseScale is a Vector3, multiply each component by roomScaleFactor
      obj.scale.copy(obj.userData.baseScale).multiplyScalar(roomScaleFactor);
    }
  });
}

/**
 * Reset room scale to default (1.0).
 */
export function resetRoomScale() {
  roomScaleFactor = 1.0;
}
