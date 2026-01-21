/**
 * MoGe-2 Client for Room Designer
 *
 * Uses the public HuggingFace Space: https://huggingface.co/spaces/Ruicheng/MoGe-2
 *
 * API Endpoint: /run
 * Inputs:
 *   - image: Input Image
 *   - number: Maximum Image Size (default: 1024)
 *   - dropdown: Inference Resolution Level (default: "high")
 *   - checkbox: Apply mask (default: true)
 *   - checkbox: Remove edges (default: true)
 *
 * Outputs:
 *   - state: internal
 *   - image: Colorized Depth Map
 *   - image: Normal Map
 *   - model3d: 3D Point Map (GLB file) <-- This is what we want!
 *   - file: Output Files
 *   - markdown: text outputs
 */

export class MoGe2Client {
  constructor() {
    this.spaceUrl = "Ruicheng/MoGe-2";
    this.client = null;
  }

  /**
   * Initialize the Gradio client connection.
   * Call this once before processing images.
   */
  async connect() {
    if (this.client) return;

    // Dynamic import of Gradio client
    const { Client } = await import("https://cdn.jsdelivr.net/npm/@gradio/client/dist/index.min.js");
    this.client = await Client.connect(this.spaceUrl);
    console.log("Connected to MoGe-2 Space");
  }

  /**
   * Process a room image and get geometry data.
   * @param {File|Blob} imageFile - Image file to process
   * @param {Object} options - Processing options
   * @param {number} options.maxSize - Maximum image size (default: 800)
   * @param {string} options.resolution - Resolution level: "Low", "Medium", "High", "Ultra" (default: "High")
   * @param {boolean} options.applyMask - Apply mask (default: true)
   * @param {boolean} options.removeEdges - Remove edges (default: true)
   * @returns {Promise<Object>} Geometry data for Three.js
   */
  async processImage(imageFile, options = {}) {
    await this.connect();

    const {
      maxSize = 800,
      resolution = "High",  // "Low", "Medium", "High", "Ultra"
      applyMask = true,
      removeEdges = true
    } = options;

    try {
      // Call the MoGe-2 Space /run endpoint
      // Uses positional arguments in order: image, max_size, resolution, apply_mask, remove_edges
      const result = await this.client.predict("/run", [
        imageFile,      // [0] Input Image
        maxSize,        // [1] Maximum Image Size (default: 800)
        resolution,     // [2] Inference Resolution Level: "Low", "Medium", "High", "Ultra"
        applyMask,      // [3] Apply mask
        removeEdges     // [4] Remove edges
      ]);

      return this._parseResult(result.data);
    } catch (error) {
      console.error("MoGe-2 processing failed:", error);
      throw error;
    }
  }

  /**
   * Parse the Gradio response into our format.
   * @private
   */
  _parseResult(data) {
    // Result data array based on actual API response:
    // [0] Colorized Depth Map (image)
    // [1] Normal Map (image)
    // [2] 3D Point Map (model3d - GLB file URL) <-- This is what we want!
    // [3] Output Files array (mesh.glb, pointcloud.ply, depth.exr, etc.)
    // [4] FOV markdown text
    // [5,6] additional notes

    console.log("MoGe-2 raw response:", data);

    // Extract the 3D model URL (GLB file) - index 2
    const model3dOutput = data[2];
    const modelUrl = model3dOutput?.url || model3dOutput?.path || model3dOutput;

    // Extract depth map - index 0
    const depthMapOutput = data[0];
    const depthMapUrl = depthMapOutput?.url || depthMapOutput?.path || depthMapOutput;

    // Extract normal map - index 1
    const normalMapOutput = data[1];
    const normalMapUrl = normalMapOutput?.url || normalMapOutput?.path || normalMapOutput;

    // Extract output files array - index 3
    const outputFiles = data[3];

    // Extract mesh.glb URL from output files (higher quality than pointcloud)
    let meshUrl = null;
    if (Array.isArray(outputFiles)) {
      const meshFile = outputFiles.find(f => f.orig_name === 'mesh.glb' || f.path?.endsWith('mesh.glb'));
      if (meshFile) {
        meshUrl = meshFile.url || meshFile.path;
      }
    }

    // Extract FOV from markdown outputs
    const fov = this._parseFovFromMarkdown(data);

    return {
      modelUrl,      // GLB file - 3D point cloud (sparse)
      meshUrl,       // GLB file - full mesh (denser, better for room bounds)
      depthMapUrl,   // Colorized depth visualization
      normalMapUrl,  // Normal map visualization
      outputFiles,   // Additional output files
      raw: data,     // Keep raw data for debugging

      camera: {
        fovHorizontal: fov.horizontal,
        fovVertical: fov.vertical,
        fov: fov.vertical || 60,  // Use vertical FOV for Three.js (default 60)
        near: 0.1,
        far: 100
      }
    };
  }

  /**
   * Parse FOV values from MoGe-2 markdown output.
   * Looks for patterns like "Horizontal FOV: 67.7°" and "Vertical FOV: 53.4°"
   * @private
   */
  _parseFovFromMarkdown(data) {
    const result = { horizontal: null, vertical: null };

    // Search through data array for strings containing FOV info
    for (let i = 0; i < data.length; i++) {
      const item = data[i];
      if (typeof item !== 'string') continue;

      // Match horizontal FOV (e.g., "Horizontal FOV: 67.7°")
      const horizMatch = item.match(/Horizontal\s+FOV[:\s]+([0-9.]+)°?/i);
      if (horizMatch) {
        result.horizontal = parseFloat(horizMatch[1]);
      }

      // Match vertical FOV (e.g., "Vertical FOV: 53.4°")
      const vertMatch = item.match(/Vertical\s+FOV[:\s]+([0-9.]+)°?/i);
      if (vertMatch) {
        result.vertical = parseFloat(vertMatch[1]);
      }
    }

    console.log("Parsed FOV:", result);
    return result;
  }

  /**
   * Simpler method: Process image and get the 3D model URL.
   * @param {File|Blob} imageFile - Image file to process
   * @returns {Promise<Object>} Object with modelUrl, meshUrl, and camera params
   */
  async processImageForRoom(imageFile) {
    const result = await this.processImage(imageFile);

    return {
      modelUrl: result.modelUrl,     // Sparse point cloud
      meshUrl: result.meshUrl,       // Dense mesh (better for room bounds)
      depthMapUrl: result.depthMapUrl,
      normalMapUrl: result.normalMapUrl,
      camera: result.camera,
      raw: result.raw
    };
  }

  /**
   * Load the 3D model from MoGe-2 directly into Three.js scene.
   * @param {THREE.Scene} scene - Three.js scene
   * @param {string} modelUrl - URL from processImageForRoom result
   * @param {Object} options - Loading options
   * @returns {Promise<THREE.Group>} Loaded model
   */
  async loadModelIntoScene(scene, modelUrl, options = {}) {
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');

    const {
      wireframe = false,
      opacity = 0.5,
      color = 0x00ff00
    } = options;

    return new Promise((resolve, reject) => {
      const loader = new GLTFLoader();

      loader.load(
        modelUrl,
        (gltf) => {
          const model = gltf.scene;

          // MoGe outputs in OpenCV coordinates, convert to Three.js
          // OpenCV: X-right, Y-down, Z-forward
          // Three.js: X-right, Y-up, Z-backward
          model.scale.set(1, -1, -1);

          // Optional: Make the mesh semi-transparent wireframe for debugging
          if (wireframe || opacity < 1) {
            model.traverse((child) => {
              if (child.isMesh) {
                child.material = new THREE.MeshBasicMaterial({
                  color: color,
                  wireframe: wireframe,
                  transparent: true,
                  opacity: opacity,
                  side: THREE.DoubleSide
                });
              }
            });
          }

          scene.add(model);
          resolve(model);
        },
        (progress) => {
          console.log('Loading model:', (progress.loaded / progress.total * 100).toFixed(1) + '%');
        },
        (error) => {
          console.error('Error loading model:', error);
          reject(error);
        }
      );
    });
  }

  /**
   * Extract bounding box from loaded model.
   * @param {THREE.Object3D} model - Loaded model from loadModelIntoScene
   * @returns {THREE.Box3} Bounding box
   */
  getBoundingBox(model) {
    const box = new THREE.Box3().setFromObject(model);
    return box;
  }

  /**
   * Get room dimensions from loaded model.
   * @param {THREE.Object3D} model - Loaded model from loadModelIntoScene
   * @returns {Object} Room dimensions {width, height, depth, center}
   */
  getRoomDimensions(model) {
    const box = this.getBoundingBox(model);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();

    box.getSize(size);
    box.getCenter(center);

    return {
      width: size.x,
      height: size.y,
      depth: size.z,
      center: { x: center.x, y: center.y, z: center.z },
      min: { x: box.min.x, y: box.min.y, z: box.min.z },
      max: { x: box.max.x, y: box.max.y, z: box.max.z }
    };
  }

  /**
   * Convert OpenCV coordinates to Three.js coordinates.
   * @param {Array} point - [x, y, z] in OpenCV coords
   * @returns {Array} [x, y, z] in Three.js coords
   */
  toThreeJS(point) {
    return [point[0], -point[1], -point[2]];
  }
}


/**
 * Usage example for RoomDesigner integration:
 *
 * import { MoGe2Client } from './huggingface-moge2/moge2-client.js';
 *
 * const moge2 = new MoGe2Client();
 *
 * async function onRoomImageUploaded(imageFile) {
 *   showLoading('Analyzing room geometry...');
 *
 *   try {
 *     // Process image with MoGe-2
 *     const result = await moge2.processImageForRoom(imageFile);
 *     console.log('MoGe-2 result:', result);
 *
 *     // Load the 3D room model
 *     if (result.modelUrl) {
 *       const roomModel = await moge2.loadModelIntoScene(scene, result.modelUrl, {
 *         wireframe: true,  // Show as wireframe for debugging
 *         opacity: 0.3,
 *         color: 0x00ff00
 *       });
 *
 *       // Get room dimensions
 *       const dims = moge2.getRoomDimensions(roomModel);
 *       console.log('Room dimensions:', dims);
 *
 *       // Use dimensions for furniture bounds clamping
 *       setRoomBounds(dims);
 *     }
 *
 *     hideLoading();
 *   } catch (error) {
 *     console.error('MoGe-2 error:', error);
 *     hideLoading();
 *     showError('Failed to analyze room geometry');
 *   }
 * }
 */
