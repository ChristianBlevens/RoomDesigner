/**
 * Screenshot Export Module
 *
 * Handles capturing room screenshots using an offscreen Three.js renderer.
 * This module is independent of the main scene to avoid affecting normal rendering.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { extractModelFromZip } from './utils.js';
import { adjustUrlForProxy } from './api.js';

// Module state
let screenshotRenderer = null;
let screenshotScene = null;
let screenshotCamera = null;
let gltfLoader = null;

/**
 * Initialize the screenshot renderer with specified dimensions.
 * Creates an offscreen WebGL renderer optimized for screenshot capture.
 *
 * @param {number} width - Canvas width in pixels
 * @param {number} height - Canvas height in pixels
 */
export function initScreenshotRenderer(width, height) {
  // Dispose previous renderer if exists
  if (screenshotRenderer) {
    screenshotRenderer.dispose();
  }

  screenshotRenderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true  // Required for toDataURL
  });
  screenshotRenderer.setSize(width, height);
  screenshotRenderer.setClearColor(0x000000, 0);
  screenshotRenderer.shadowMap.enabled = true;
  screenshotRenderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // Initialize scene
  screenshotScene = new THREE.Scene();

  // Initialize camera (will be configured per-room)
  screenshotCamera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000);

  // Initialize loader
  if (!gltfLoader) {
    gltfLoader = new GLTFLoader();
  }

  return { renderer: screenshotRenderer, scene: screenshotScene, camera: screenshotCamera };
}

/**
 * Clear all objects from the screenshot scene.
 * Properly disposes of geometries, materials, and textures to prevent memory leaks.
 */
export function clearScreenshotScene() {
  if (!screenshotScene) return;

  // Traverse and dispose all objects
  screenshotScene.traverse((object) => {
    if (object.geometry) {
      object.geometry.dispose();
    }
    if (object.material) {
      if (Array.isArray(object.material)) {
        object.material.forEach(material => disposeMaterial(material));
      } else {
        disposeMaterial(object.material);
      }
    }
  });

  // Remove all children
  while (screenshotScene.children.length > 0) {
    screenshotScene.remove(screenshotScene.children[0]);
  }
}

/**
 * Dispose of a Three.js material and its textures.
 * @param {THREE.Material} material
 */
function disposeMaterial(material) {
  if (material.map) material.map.dispose();
  if (material.lightMap) material.lightMap.dispose();
  if (material.bumpMap) material.bumpMap.dispose();
  if (material.normalMap) material.normalMap.dispose();
  if (material.specularMap) material.specularMap.dispose();
  if (material.envMap) material.envMap.dispose();
  material.dispose();
}

/**
 * Dispose of the screenshot renderer and free resources.
 */
export function disposeScreenshotRenderer() {
  clearScreenshotScene();
  if (screenshotRenderer) {
    screenshotRenderer.dispose();
    screenshotRenderer = null;
  }
  screenshotScene = null;
  screenshotCamera = null;
}

/**
 * Get the dimensions of an image blob.
 *
 * @param {Blob} imageBlob - The image as a Blob
 * @returns {Promise<{width: number, height: number}>} Image dimensions
 */
export function getImageDimensions(imageBlob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(imageBlob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.width, height: img.height });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image for dimensions'));
    };
    img.src = url;
  });
}

/**
 * Set up the screenshot camera for MoGe-aligned rendering.
 * Matches the camera configuration used in the main scene.
 *
 * @param {number} fov - Vertical field of view in degrees
 * @param {number} aspect - Image aspect ratio (width/height)
 */
export function setupScreenshotCamera(fov, aspect) {
  if (!screenshotCamera) return;

  // MoGe alignment: camera at origin, looking into -Z
  screenshotCamera.position.set(0, 0, 0);
  screenshotCamera.rotation.set(0, 0, 0);
  screenshotCamera.lookAt(0, 0, -1);

  screenshotCamera.fov = fov;
  screenshotCamera.aspect = aspect;
  screenshotCamera.updateProjectionMatrix();
}

/**
 * Add standard lighting to the screenshot scene.
 *
 * @param {Object} lightingSettings - Optional lighting settings from room data
 * @returns {THREE.DirectionalLight} The directional light (for potential updates)
 */
export function addScreenshotLighting(lightingSettings = null) {
  if (!screenshotScene) return null;

  // Ambient light (same as main scene)
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  screenshotScene.add(ambientLight);

  // Directional light
  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
  directionalLight.castShadow = true;
  directionalLight.shadow.mapSize.width = 2048;
  directionalLight.shadow.mapSize.height = 2048;
  directionalLight.shadow.camera.near = 0.5;
  directionalLight.shadow.camera.far = 50;
  directionalLight.shadow.camera.left = -10;
  directionalLight.shadow.camera.right = 10;
  directionalLight.shadow.camera.top = 10;
  directionalLight.shadow.camera.bottom = -10;
  directionalLight.shadow.bias = -0.0005;
  directionalLight.shadow.normalBias = 0.02;

  // Apply saved lighting settings or use defaults
  if (lightingSettings) {
    directionalLight.intensity = lightingSettings.intensity ?? 0.8;

    if (lightingSettings.position) {
      directionalLight.position.set(
        lightingSettings.position.x,
        lightingSettings.position.y,
        lightingSettings.position.z
      );
    } else {
      directionalLight.position.set(5, 10, 7.5);
    }

    if (lightingSettings.target) {
      directionalLight.target.position.set(
        lightingSettings.target.x,
        lightingSettings.target.y,
        lightingSettings.target.z
      );
    }

    // Apply color temperature if available
    if (lightingSettings.temperature) {
      const color = kelvinToRGB(lightingSettings.temperature);
      directionalLight.color.setRGB(color.r, color.g, color.b);
    }
  } else {
    directionalLight.position.set(5, 10, 7.5);
  }

  screenshotScene.add(directionalLight);
  screenshotScene.add(directionalLight.target);

  return directionalLight;
}

/**
 * Convert color temperature in Kelvin to RGB values.
 * Algorithm based on Tanner Helland's implementation.
 *
 * @param {number} kelvin - Color temperature (1000-40000K)
 * @returns {{r: number, g: number, b: number}} RGB values normalized to 0-1
 */
function kelvinToRGB(kelvin) {
  const temp = kelvin / 100;
  let r, g, b;

  if (temp <= 66) {
    r = 255;
    g = Math.max(0, Math.min(255, 99.4708025861 * Math.log(temp) - 161.1195681661));
  } else {
    r = Math.max(0, Math.min(255, 329.698727446 * Math.pow(temp - 60, -0.1332047592)));
    g = Math.max(0, Math.min(255, 288.1221695283 * Math.pow(temp - 60, -0.0755148492)));
  }

  if (temp >= 66) {
    b = 255;
  } else if (temp <= 19) {
    b = 0;
  } else {
    b = Math.max(0, Math.min(255, 138.5177312231 * Math.log(temp - 10) - 305.0447927307));
  }

  return { r: r / 255, g: g / 255, b: b / 255 };
}

/**
 * Create a background image plane for the screenshot scene.
 * Replicates the background plane setup from scene.js.
 *
 * @param {Blob} imageBlob - The room background image
 * @param {number} depth - Distance from camera
 * @param {number} fov - Camera field of view
 * @param {number} imageAspect - Image aspect ratio
 * @returns {Promise<THREE.Mesh>} The background plane mesh
 */
export async function createBackgroundPlane(imageBlob, depth, fov, imageAspect) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(imageBlob);
    const textureLoader = new THREE.TextureLoader();

    textureLoader.load(
      url,
      (texture) => {
        URL.revokeObjectURL(url);

        // Configure texture
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.colorSpace = THREE.SRGBColorSpace;

        // Calculate plane size to fill viewport at depth
        const fovRad = fov * Math.PI / 180;
        const visibleHeight = 2 * Math.tan(fovRad / 2) * depth;
        const visibleWidth = visibleHeight * screenshotCamera.aspect;

        let planeWidth, planeHeight;
        if (screenshotCamera.aspect > imageAspect) {
          planeHeight = visibleHeight;
          planeWidth = planeHeight * imageAspect;
        } else {
          planeWidth = visibleWidth;
          planeHeight = planeWidth / imageAspect;
        }

        const geometry = new THREE.PlaneGeometry(planeWidth, planeHeight);
        const material = new THREE.MeshBasicMaterial({
          map: texture,
          side: THREE.FrontSide,
          depthWrite: true,
          depthTest: true,
          toneMapped: false
        });

        const plane = new THREE.Mesh(geometry, material);
        plane.position.set(0, 0, -depth);
        plane.renderOrder = -1;

        screenshotScene.add(plane);
        resolve(plane);
      },
      undefined,
      (error) => {
        URL.revokeObjectURL(url);
        reject(error);
      }
    );
  });
}

/**
 * Load room mesh geometry into the screenshot scene.
 * The mesh is invisible but included for proper scene bounds.
 * Returns the mesh bounds for background plane positioning.
 *
 * @param {string} meshUrl - URL to the room mesh GLB file
 * @returns {Promise<{mesh: THREE.Object3D, bounds: THREE.Box3}>} The loaded mesh and its bounds
 */
export async function loadRoomMesh(meshUrl) {
  // Adjust URL for proxy if needed (same as main scene does)
  const adjustedUrl = adjustUrlForProxy(meshUrl);

  return new Promise((resolve, reject) => {
    gltfLoader.load(
      adjustedUrl,
      (gltf) => {
        const mesh = gltf.scene;

        // MoGe mesh coordinate system is already correct (no transformation needed)
        mesh.scale.set(1, 1, 1);

        // Calculate bounds before making invisible
        const bounds = new THREE.Box3().setFromObject(mesh);

        // ShadowMaterial is invisible except where shadows fall
        mesh.traverse((child) => {
          if (child.isMesh) {
            child.material = new THREE.ShadowMaterial({
              opacity: 0.4,
              side: THREE.DoubleSide
            });
            child.receiveShadow = true;
          }
        });

        screenshotScene.add(mesh);

        // Update shadow camera to encompass room bounds
        const size = bounds.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) * 1.5;
        // Find directional light and update shadow camera
        screenshotScene.traverse((obj) => {
          if (obj.isDirectionalLight && obj.castShadow) {
            obj.shadow.camera.left = -maxDim;
            obj.shadow.camera.right = maxDim;
            obj.shadow.camera.top = maxDim;
            obj.shadow.camera.bottom = -maxDim;
            obj.shadow.camera.far = maxDim * 3;
            obj.shadow.camera.updateProjectionMatrix();
          }
        });

        resolve({ mesh, bounds });
      },
      undefined,
      reject
    );
  });
}

/**
 * Load a furniture model from entry data.
 *
 * @param {Object} entry - Furniture entry with model blob
 * @returns {Promise<THREE.Object3D>} The loaded model
 */
export async function loadFurnitureModel(entry) {
  if (!entry.model) {
    throw new Error('Furniture entry has no model');
  }

  const extractedData = await extractModelFromZip(entry.model);
  const url = URL.createObjectURL(extractedData.modelBlob);

  return new Promise((resolve, reject) => {
    gltfLoader.load(
      url,
      (gltf) => {
        URL.revokeObjectURL(url);
        const model = gltf.scene;

        // Enable shadows
        model.traverse((child) => {
          if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });

        resolve(model);
      },
      undefined,
      (error) => {
        URL.revokeObjectURL(url);
        reject(error);
      }
    );
  });
}

/**
 * Apply saved transform data to a furniture model.
 *
 * @param {THREE.Object3D} model - The furniture model
 * @param {Object} furnitureData - Saved furniture data with position, rotation, scale
 */
export function applyFurnitureTransform(model, furnitureData) {
  // Position
  model.position.set(
    furnitureData.position.x,
    furnitureData.position.y,
    furnitureData.position.z
  );

  // Rotation
  model.rotation.set(
    furnitureData.rotation.x,
    furnitureData.rotation.y,
    furnitureData.rotation.z
  );

  // Scale (handle both uniform number and vector object)
  if (typeof furnitureData.scale === 'number') {
    model.scale.setScalar(furnitureData.scale);
  } else if (furnitureData.scale && typeof furnitureData.scale === 'object') {
    model.scale.set(
      furnitureData.scale.x,
      furnitureData.scale.y,
      furnitureData.scale.z
    );
  }
}

/**
 * Capture a screenshot of the current screenshot scene.
 *
 * @param {string} format - Image format ('image/png' or 'image/jpeg')
 * @param {number} quality - JPEG quality (0-1), ignored for PNG
 * @returns {Promise<Blob>} Screenshot as Blob
 */
export async function captureScreenshot(format = 'image/png', quality = 0.92) {
  if (!screenshotRenderer || !screenshotScene || !screenshotCamera) {
    throw new Error('Screenshot renderer not initialized');
  }

  // Render the scene
  screenshotRenderer.render(screenshotScene, screenshotCamera);

  // Small delay to ensure GPU has finished
  await new Promise(resolve => setTimeout(resolve, 50));

  // Render again for good measure (ensures all textures uploaded)
  screenshotRenderer.render(screenshotScene, screenshotCamera);

  // Capture as data URL
  const dataUrl = screenshotRenderer.domElement.toDataURL(format, quality);

  // Convert to Blob
  const response = await fetch(dataUrl);
  return response.blob();
}

/**
 * Capture a complete room screenshot.
 * This is the main entry point for screenshot capture.
 *
 * @param {Object} roomData - Room data including mogeData, backgroundImage, placedFurniture, lightingSettings
 * @param {Map<string, Object>} furnitureEntries - Map of entryId to furniture entry objects (with model blobs)
 * @returns {Promise<Blob>} Screenshot as PNG Blob
 */
export async function captureRoomScreenshot(roomData, furnitureEntries) {
  // Get image dimensions for renderer size
  const dimensions = await getImageDimensions(roomData.backgroundImage);

  // Initialize renderer at image resolution
  initScreenshotRenderer(dimensions.width, dimensions.height);

  // Clear any previous content
  clearScreenshotScene();

  // Get room parameters
  const fov = roomData.mogeData?.cameraFov || 60;
  const imageAspect = roomData.mogeData?.imageAspect || (dimensions.width / dimensions.height);

  // Set up camera
  setupScreenshotCamera(fov, imageAspect);

  // Add lighting
  addScreenshotLighting(roomData.lightingSettings);

  // Default background depth
  let backgroundDepth = 10;

  // Load room mesh (if available) and get bounds for background depth
  if (roomData.mogeData?.meshUrl) {
    try {
      const { bounds } = await loadRoomMesh(roomData.mogeData.meshUrl);
      // Calculate background depth from mesh bounds (same formula as main scene)
      // Background plane should be behind all mesh geometry
      backgroundDepth = Math.abs(bounds.min.z) + 1;
    } catch (err) {
      console.warn('Failed to load room mesh for screenshot:', err);
      // Continue without mesh - furniture will still render
    }
  }

  // Load background image plane
  await createBackgroundPlane(roomData.backgroundImage, backgroundDepth, fov, imageAspect);

  // Load placed furniture
  if (roomData.placedFurniture && roomData.placedFurniture.length > 0) {
    for (const furniture of roomData.placedFurniture) {
      try {
        const entry = furnitureEntries.get(furniture.entryId);
        if (!entry || !entry.model) {
          console.warn(`Skipping furniture ${furniture.entryId}: no model available`);
          continue;
        }

        const model = await loadFurnitureModel(entry);
        applyFurnitureTransform(model, furniture);
        screenshotScene.add(model);
      } catch (err) {
        console.warn(`Failed to load furniture ${furniture.entryId}:`, err);
        // Continue with remaining furniture
      }
    }
  }

  // Capture and return screenshot
  const screenshot = await captureScreenshot('image/png');

  return screenshot;
}
