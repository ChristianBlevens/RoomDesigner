// Furniture management and interaction for Room Furniture Planner

import * as THREE from 'three';
import {
  getScene,
  getRenderer,
  getTransformControls,
  raycastFurniture,
  raycastFloor,
  raycastRoomSurface,
  addFurnitureToScene,
  removeFurnitureFromScene,
  loadModelFromExtractedZip,
  calculateFurnitureScale,
  selectableObjects,
  getRoomMesh
} from './scene.js';
import {
  undoManager,
  PlaceFurnitureCommand,
  MoveFurnitureCommand,
  RotateFurnitureCommand,
  ScaleFurnitureCommand,
  DeleteFurnitureCommand
} from './undo.js';
import { getFurnitureEntry } from './api.js';
import { modalManager } from './modals.js';
import { extractModelFromZip } from './utils.js';
import { isLightingDirectionMode } from './main.js';

// Interaction state
let selectedObject = null;
let hoveredObject = null;
let isDragging = false;
let mouseDownPosition = null;
let dragStartPosition = null;

// Transform tracking for undo
let transformStartPosition = null;
let transformStartRotation = null;
let transformStartScale = null;

// Thresholds
const DRAG_THRESHOLD_PIXELS = 5;

// Running normal average for smooth dragging (stores last N normals)
const NORMAL_HISTORY_SIZE = 10;
let normalHistory = [];

// Cardinal axes for contact face detection
const CARDINAL_AXES = [
  new THREE.Vector3(1, 0, 0),   // +X (right face contact)
  new THREE.Vector3(-1, 0, 0),  // -X (left face contact)
  new THREE.Vector3(0, 1, 0),   // +Y (bottom face contact) - DEFAULT
  new THREE.Vector3(0, -1, 0),  // -Y (top face contact)
  new THREE.Vector3(0, 0, 1),   // +Z (back face contact)
  new THREE.Vector3(0, 0, -1),  // -Z (front face contact)
];

// Default contact axis (model bottom against surface - for floor placement)
const DEFAULT_CONTACT_AXIS = new THREE.Vector3(0, 1, 0);

// Threshold for detecting surface change (cosine of ~45°)
const SURFACE_CHANGE_THRESHOLD = 0.7;

/**
 * Add a normal to the history and return the averaged normal.
 * @param {THREE.Vector3} normal - The new normal to add
 * @returns {THREE.Vector3} - Averaged normal from history
 */
function addNormalToHistory(normal) {
  normalHistory.push(normal.clone());
  if (normalHistory.length > NORMAL_HISTORY_SIZE) {
    normalHistory.shift();
  }

  // Compute average
  const avg = new THREE.Vector3(0, 0, 0);
  for (const n of normalHistory) {
    avg.add(n);
  }
  return avg.divideScalar(normalHistory.length).normalize();
}

/**
 * Clear the normal history (call when drag ends).
 */
function clearNormalHistory() {
  normalHistory = [];
}

/**
 * Detect which face of the model is currently facing the surface.
 * Returns the local axis that should point AWAY from the surface.
 *
 * @param {THREE.Object3D} model - The furniture model
 * @param {THREE.Vector3} surfaceNormal - Surface normal in world space
 * @returns {THREE.Vector3} Local axis that aligns with surface normal
 */
function detectContactAxis(model, surfaceNormal) {
  let bestAxis = DEFAULT_CONTACT_AXIS.clone();
  let bestDot = -2;

  for (const localAxis of CARDINAL_AXES) {
    // Transform local axis to world space using model's current rotation
    const worldAxis = localAxis.clone().applyQuaternion(model.quaternion);

    // Find which axis is most aligned with surface normal
    // (pointing away from surface = pointing along normal)
    const dot = worldAxis.dot(surfaceNormal);

    if (dot > bestDot) {
      bestDot = dot;
      bestAxis = localAxis.clone();
    }
  }

  return bestAxis;
}

/**
 * Calculate rotation around surface normal to keep model upright.
 * "Upright" means model's local Y points as close to world +Y as possible.
 *
 * @param {THREE.Vector3} surfaceNormal - Surface normal
 * @param {THREE.Vector3} contactAxis - Local axis aligned to normal
 * @returns {number} Rotation in radians around surface normal
 */
function calculateUprightRotation(surfaceNormal, contactAxis) {
  const worldUp = new THREE.Vector3(0, 1, 0);

  // For horizontal surfaces (floor/ceiling), no upright adjustment needed
  // User rotation handles the orientation
  if (Math.abs(surfaceNormal.y) > 0.9) {
    return 0;
  }

  // Project world up onto plane perpendicular to surface normal
  const projectedWorldUp = worldUp.clone().sub(
    surfaceNormal.clone().multiplyScalar(worldUp.dot(surfaceNormal))
  );

  if (projectedWorldUp.length() < 0.001) {
    return 0;
  }
  projectedWorldUp.normalize();

  // Calculate where model's Y ends up after base alignment
  const baseQuat = new THREE.Quaternion();
  baseQuat.setFromUnitVectors(contactAxis.clone().normalize(), surfaceNormal.clone().normalize());

  const modelYAfterBase = new THREE.Vector3(0, 1, 0).applyQuaternion(baseQuat);

  // Project model's Y onto same plane
  const projectedModelY = modelYAfterBase.clone().sub(
    surfaceNormal.clone().multiplyScalar(modelYAfterBase.dot(surfaceNormal))
  );

  if (projectedModelY.length() < 0.001) {
    return 0;
  }
  projectedModelY.normalize();

  // Calculate angle between projected vectors
  let angle = Math.acos(Math.max(-1, Math.min(1, projectedModelY.dot(projectedWorldUp))));

  // Determine sign using cross product
  const cross = new THREE.Vector3().crossVectors(projectedModelY, projectedWorldUp);
  if (cross.dot(surfaceNormal) < 0) {
    angle = -angle;
  }

  return angle;
}

/**
 * Align furniture to surface by rotating the contact face to be flat against the surface.
 * This is an INCREMENTAL rotation that preserves the model's other orientation aspects.
 *
 * @param {THREE.Object3D} model - The furniture model
 * @param {THREE.Vector3} surfaceNormal - Surface normal (world space)
 * @param {THREE.Vector3} contactAxis - Local axis that should point away from surface
 */
function alignContactAxisToSurface(model, surfaceNormal, contactAxis) {
  const normalizedNormal = surfaceNormal.clone().normalize();
  const normalizedAxis = contactAxis.clone().normalize();

  // Where is the contact axis currently pointing in WORLD space?
  const currentWorldContactDir = normalizedAxis.clone().applyQuaternion(model.quaternion).normalize();

  // Calculate the rotation needed to align current direction with surface normal
  const correctionQuat = new THREE.Quaternion();
  correctionQuat.setFromUnitVectors(currentWorldContactDir, normalizedNormal);

  // Apply correction to the model's CURRENT orientation (preserves other rotation aspects)
  model.quaternion.premultiply(correctionQuat);
}

/**
 * Apply upright correction so model's Y axis is as close to world up as possible.
 * Call this AFTER alignContactAxisToSurface.
 *
 * @param {THREE.Object3D} model - The furniture model
 * @param {THREE.Vector3} surfaceNormal - Surface normal (world space)
 */
function applyUprightCorrection(model, surfaceNormal) {
  const normalizedNormal = surfaceNormal.clone().normalize();

  // For horizontal surfaces (floor/ceiling), skip upright correction
  // User rotation around Y handles orientation
  if (Math.abs(normalizedNormal.y) > 0.9) {
    return;
  }

  // Get model's current Y axis in world space
  const modelY = new THREE.Vector3(0, 1, 0).applyQuaternion(model.quaternion).normalize();

  // Project both model Y and world up onto the plane perpendicular to surface normal
  const worldUp = new THREE.Vector3(0, 1, 0);

  const projectedWorldUp = worldUp.clone().sub(
    normalizedNormal.clone().multiplyScalar(worldUp.dot(normalizedNormal))
  );
  if (projectedWorldUp.length() < 0.001) return;
  projectedWorldUp.normalize();

  const projectedModelY = modelY.clone().sub(
    normalizedNormal.clone().multiplyScalar(modelY.dot(normalizedNormal))
  );
  if (projectedModelY.length() < 0.001) return;
  projectedModelY.normalize();

  // Calculate angle between them
  let angle = Math.acos(Math.max(-1, Math.min(1, projectedModelY.dot(projectedWorldUp))));

  // Determine sign
  const cross = new THREE.Vector3().crossVectors(projectedModelY, projectedWorldUp);
  if (cross.dot(normalizedNormal) < 0) {
    angle = -angle;
  }

  // Apply upright rotation around surface normal
  if (Math.abs(angle) > 0.001) {
    const uprightQuat = new THREE.Quaternion();
    uprightQuat.setFromAxisAngle(normalizedNormal, angle);
    model.quaternion.premultiply(uprightQuat);
  }
}

// Gizmo menu element
let gizmoMenu = null;

/**
 * Align furniture to a new surface. Called when surface type changes during drag.
 * Uses incremental rotation to preserve the model's orientation as much as possible.
 *
 * @param {THREE.Object3D} model - The furniture model
 * @param {THREE.Vector3} surfaceNormal - The new surface normal vector
 * @param {THREE.Vector3} contactAxis - Local axis that should align with normal
 */
function alignToSurface(model, surfaceNormal, contactAxis) {
  const axis = contactAxis || model.userData.contactAxis || DEFAULT_CONTACT_AXIS;

  // Step 1: Rotate so the contact axis points along surface normal
  alignContactAxisToSurface(model, surfaceNormal, axis);

  // Step 2: Apply upright correction (keep model's Y close to world up)
  applyUprightCorrection(model, surfaceNormal);
}

/**
 * Rotate furniture around its placement surface normal.
 * @param {THREE.Object3D} model - The furniture model
 * @param {number} deltaAngle - Angle to rotate (radians)
 */
function rotateFurnitureOnSurface(model, deltaAngle) {
  if (!model.userData.surfaceNormal) {
    // Fallback: rotate around Y if no surface info
    model.rotation.y += deltaAngle;
    return;
  }

  // Rotate around the surface normal
  const normal = model.userData.surfaceNormal.clone().normalize();
  const rotQuat = new THREE.Quaternion();
  rotQuat.setFromAxisAngle(normal, deltaAngle);
  model.quaternion.premultiply(rotQuat);
}

/**
 * Extract user rotation around surface normal from model's current orientation.
 * Used to preserve rotation when starting a new drag.
 *
 * @param {THREE.Object3D} model - The furniture model
 * @returns {number} User rotation in radians
 */
function extractRotationAroundNormal(model) {
  const surfaceNormal = model.userData.surfaceNormal;
  const contactAxis = model.userData.contactAxis || DEFAULT_CONTACT_AXIS;
  const uprightRotation = model.userData.uprightRotation || 0;

  if (!surfaceNormal) {
    return model.rotation.y; // Fallback
  }

  const normalizedNormal = surfaceNormal.clone().normalize();
  const normalizedAxis = contactAxis.clone().normalize();

  // Reconstruct the "expected" quaternion without user rotation
  const baseQuat = new THREE.Quaternion();
  baseQuat.setFromUnitVectors(normalizedAxis, normalizedNormal);

  const uprightQuat = new THREE.Quaternion();
  uprightQuat.setFromAxisAngle(normalizedNormal, uprightRotation);

  const expectedQuat = baseQuat.clone().premultiply(uprightQuat);

  // The difference between expected and actual is the user rotation
  const expectedInverse = expectedQuat.clone().invert();
  const diffQuat = model.quaternion.clone().premultiply(expectedInverse);

  // Extract angle from difference quaternion
  const angle = 2 * Math.acos(Math.max(-1, Math.min(1, Math.abs(diffQuat.w))));

  if (angle < 0.001) {
    return 0;
  }

  // Determine sign
  const sinHalfAngle = Math.sqrt(1 - diffQuat.w * diffQuat.w);
  if (sinHalfAngle < 0.001) {
    return 0;
  }

  const axis = new THREE.Vector3(
    diffQuat.x / sinHalfAngle,
    diffQuat.y / sinHalfAngle,
    diffQuat.z / sinHalfAngle
  );

  return axis.dot(normalizedNormal) < 0 ? -angle : angle;
}

// Callback for opening furniture modal
let onOpenFurnitureModal = null;

// Store click position and surface info for placing furniture
let lastClickPosition = null;
let lastClickSurfaceNormal = null;

export function setOpenFurnitureModalCallback(callback) {
  onOpenFurnitureModal = callback;
}

export function getLastClickPosition() {
  return lastClickPosition;
}

export function getLastClickSurfaceNormal() {
  return lastClickSurfaceNormal;
}

export function getSelectedObject() {
  return selectedObject;
}

// Initialize furniture interaction handlers
export function initFurnitureInteraction() {
  const renderer = getRenderer();
  const canvas = renderer.domElement;
  gizmoMenu = document.getElementById('gizmo-menu');

  // Mouse down
  canvas.addEventListener('mousedown', onMouseDown);

  // Mouse move
  canvas.addEventListener('mousemove', onMouseMove);

  // Mouse up
  canvas.addEventListener('mouseup', onMouseUp);

  // Setup gizmo buttons
  setupGizmoButtons();

  // Setup transform controls events
  setupTransformControls();

  // Keyboard shortcuts
  window.addEventListener('keydown', onKeyDown);
}

function onMouseDown(event) {
  if (event.button !== 0) return;
  if (modalManager.isModalOpen()) return;

  mouseDownPosition = { x: event.clientX, y: event.clientY };

  // Check if clicking on furniture
  const hit = raycastFurniture(event);

  if (hit && hit.object) {
    hoveredObject = hit.object;
    dragStartPosition = hit.object.position.clone();

    // Capture orientation state BEFORE drag starts
    if (hit.object.userData.surfaceNormal) {
      // Re-detect contact axis based on CURRENT orientation
      // This captures any rotation applied by the 3D gizmo
      const currentContactAxis = detectContactAxis(hit.object, hit.object.userData.surfaceNormal);
      hit.object.userData.contactAxis = currentContactAxis;

      // Store the surface normal for surface-change detection during drag
      hit.object.userData.previousSurfaceNormal = hit.object.userData.surfaceNormal.clone();

      console.log('Drag start - contact axis:', currentContactAxis.toArray());
    }
  } else {
    // Store click position and surface info for potential furniture placement
    const surfaceHit = raycastRoomSurface(event);
    if (surfaceHit) {
      lastClickPosition = surfaceHit.point.clone();
      lastClickSurfaceNormal = surfaceHit.normal.clone();
    }
  }
}

function onMouseMove(event) {
  if (!mouseDownPosition || !hoveredObject) return;
  if (modalManager.isModalOpen()) return;

  const dx = event.clientX - mouseDownPosition.x;
  const dy = event.clientY - mouseDownPosition.y;
  const distance = Math.sqrt(dx * dx + dy * dy);

  // If moved past threshold, start dragging
  if (!isDragging && distance > DRAG_THRESHOLD_PIXELS) {
    // Don't allow drag if transform controls are attached to this object
    // User must interact with the gizmo or deselect first
    const transformControls = getTransformControls();
    if (transformControls.object === hoveredObject) {
      // Transform gizmo is active on this object - don't start drag
      return;
    }

    isDragging = true;

    // Hide gizmo menu if visible (but transform controls weren't attached)
    hideGizmoMenu();
  }

  // Continue dragging - furniture follows mesh surface
  if (isDragging && hoveredObject) {
    // Use fast single-ray cast, then smooth with running average
    const surfaceHit = raycastRoomSurface(event, { sampleCount: 0 });

    if (surfaceHit) {
      // Update position
      hoveredObject.position.copy(surfaceHit.point);

      // Smooth the normal
      const smoothedNormal = addNormalToHistory(surfaceHit.normal);

      // Check if surface changed significantly (e.g., floor to wall transition)
      const previousNormal = hoveredObject.userData.previousSurfaceNormal;
      const surfaceChanged = !previousNormal ||
        previousNormal.dot(smoothedNormal) < SURFACE_CHANGE_THRESHOLD;

      if (surfaceChanged) {
        // Clear normal history to prevent old surface normals from contaminating the new surface
        clearNormalHistory();
        // Start fresh history with current normal
        const freshNormal = addNormalToHistory(surfaceHit.normal);

        // Detect which face is now facing the new surface
        const newContactAxis = detectContactAxis(hoveredObject, freshNormal);

        console.log('Surface transition detected:', {
          contactAxis: newContactAxis.toArray(),
          previousNormal: previousNormal ? previousNormal.toArray() : 'none',
          newNormal: freshNormal.toArray()
        });

        // Store the new contact axis and surface normal
        hoveredObject.userData.contactAxis = newContactAxis;
        hoveredObject.userData.previousSurfaceNormal = freshNormal.clone();
        hoveredObject.userData.surfaceNormal = freshNormal.clone();

        // Align contact face to the new surface
        alignToSurface(hoveredObject, freshNormal, newContactAxis);
      } else {
        // Same surface type - update normal
        hoveredObject.userData.surfaceNormal = smoothedNormal.clone();

        // Keep contact axis aligned (handles minor normal variations)
        const contactAxis = hoveredObject.userData.contactAxis || DEFAULT_CONTACT_AXIS;
        alignContactAxisToSurface(hoveredObject, smoothedNormal, contactAxis);

        // Continuously apply upright correction for non-horizontal surfaces
        // This stabilizes the model despite bumpy normals
        applyUprightCorrection(hoveredObject, smoothedNormal);
      }
    }
  }
}

function onMouseUp(event) {
  if (modalManager.isModalOpen()) {
    resetMouseState();
    return;
  }

  if (isDragging && hoveredObject && dragStartPosition) {
    // Drag completed - record undo action
    const endPosition = hoveredObject.position.clone();
    if (!dragStartPosition.equals(endPosition)) {
      undoManager.record(new MoveFurnitureCommand(
        hoveredObject,
        dragStartPosition,
        endPosition
      ));
    }
    selectedObject = hoveredObject;
  } else if (hoveredObject && mouseDownPosition) {
    // Check if this was a click (not a drag)
    const dx = event.clientX - mouseDownPosition.x;
    const dy = event.clientY - mouseDownPosition.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance <= DRAG_THRESHOLD_PIXELS) {
      // This was a click - select and show gizmo
      selectFurniture(hoveredObject, event);
    }
  } else if (!hoveredObject && mouseDownPosition) {
    // Click on empty space
    const dx = event.clientX - mouseDownPosition.x;
    const dy = event.clientY - mouseDownPosition.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance <= DRAG_THRESHOLD_PIXELS) {
      // If something was selected, just deselect
      if (selectedObject) {
        deselectFurniture();
      } else if (!isLightingDirectionMode()) {
        // Open furniture modal (but not if in lighting direction mode)
        if (onOpenFurnitureModal) {
          onOpenFurnitureModal();
        }
      }
    }
  }

  resetMouseState();
}

function resetMouseState() {
  isDragging = false;
  mouseDownPosition = null;
  dragStartPosition = null;
  clearNormalHistory();

  // Clear the previous surface normal tracking
  if (hoveredObject) {
    delete hoveredObject.userData.previousSurfaceNormal;
  }
  hoveredObject = null;
}

function selectFurniture(object, event) {
  if (selectedObject === object) {
    // Already selected - hide 3D gizmo and show menu again
    const transformControls = getTransformControls();
    transformControls.detach();
    showGizmoMenu(event);
    return;
  }

  deselectFurniture();
  selectedObject = object;

  // Don't attach transform controls yet - show menu first
  // Transform controls will be attached when user selects a mode
  const transformControls = getTransformControls();
  transformControls.detach();

  // Show gizmo menu
  showGizmoMenu(event);

  // Store initial transform for undo
  transformStartPosition = object.position.clone();
  transformStartRotation = object.rotation.clone();
  transformStartScale = object.scale.clone();
}

export function deselectFurniture() {
  if (!selectedObject) return;

  const transformControls = getTransformControls();
  transformControls.detach();

  // Reset to translate mode (drag is the default)
  transformControls.setMode('translate');

  hideGizmoMenu();
  selectedObject = null;

  transformStartPosition = null;
  transformStartRotation = null;
  transformStartScale = null;
}

function showGizmoMenu(event) {
  if (!gizmoMenu || !selectedObject) return;

  // Position gizmo above the clicked point
  gizmoMenu.style.left = `${event.clientX}px`;
  gizmoMenu.style.top = `${event.clientY - 10}px`;
  gizmoMenu.classList.remove('modal-hidden');
}

function hideGizmoMenu() {
  if (gizmoMenu) {
    gizmoMenu.classList.add('modal-hidden');
  }
}

function setupGizmoButtons() {
  const dragBtn = document.getElementById('gizmo-drag-btn');
  const rotateBtn = document.getElementById('gizmo-rotate-btn');
  const scaleBtn = document.getElementById('gizmo-scale-btn');
  const deleteBtn = document.getElementById('gizmo-delete-btn');

  const transformControls = getTransformControls();

  dragBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (selectedObject) {
      transformControls.attach(selectedObject);
      transformControls.setMode('translate');
    }
    hideGizmoMenu();
  });

  rotateBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (selectedObject) {
      transformControls.attach(selectedObject);
      transformControls.setMode('rotate');
    }
    hideGizmoMenu();
  });

  scaleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (selectedObject) {
      transformControls.attach(selectedObject);
      transformControls.setMode('scale');
    }
    hideGizmoMenu();
  });

  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteSelectedFurniture();
  });

  // Prevent gizmo menu clicks from propagating
  gizmoMenu.addEventListener('click', (e) => {
    e.stopPropagation();
  });
}

function setupTransformControls() {
  const transformControls = getTransformControls();

  transformControls.addEventListener('mouseDown', () => {
    if (selectedObject) {
      transformStartPosition = selectedObject.position.clone();
      transformStartRotation = selectedObject.rotation.clone();
      transformStartScale = selectedObject.scale.clone();
    }
  });

  transformControls.addEventListener('mouseUp', () => {
    if (selectedObject && transformStartPosition) {
      const mode = transformControls.getMode();

      if (mode === 'translate') {
        const endPosition = selectedObject.position.clone();
        if (!transformStartPosition.equals(endPosition)) {
          undoManager.record(new MoveFurnitureCommand(
            selectedObject,
            transformStartPosition,
            selectedObject.position.clone()
          ));
        }
      } else if (mode === 'rotate') {
        const endRotation = selectedObject.rotation.clone();
        if (!transformStartRotation.equals(endRotation)) {
          undoManager.record(new RotateFurnitureCommand(
            selectedObject,
            transformStartRotation,
            endRotation
          ));
        }
      } else if (mode === 'scale') {
        const endScale = selectedObject.scale.clone();
        if (!transformStartScale.equals(endScale)) {
          undoManager.record(new ScaleFurnitureCommand(
            selectedObject,
            transformStartScale,
            selectedObject.scale.clone()
          ));
        }
      }
    }
  });

  // Handle change event for continuous clamping and uniform scaling
  transformControls.addEventListener('change', () => {
    if (selectedObject && transformControls.dragging) {
      const mode = transformControls.getMode();

      if (mode === 'scale' && transformStartScale) {
        // Enforce uniform scaling by comparing to the fixed start scale
        const currentScale = selectedObject.scale;

        // Calculate scale ratios from the starting scale
        const ratioX = transformStartScale.x !== 0 ? currentScale.x / transformStartScale.x : 1;
        const ratioY = transformStartScale.y !== 0 ? currentScale.y / transformStartScale.y : 1;
        const ratioZ = transformStartScale.z !== 0 ? currentScale.z / transformStartScale.z : 1;

        // Find which axis changed the most (furthest ratio from 1.0)
        const devX = Math.abs(ratioX - 1);
        const devY = Math.abs(ratioY - 1);
        const devZ = Math.abs(ratioZ - 1);

        let uniformRatio;
        if (devX >= devY && devX >= devZ) {
          uniformRatio = ratioX;
        } else if (devY >= devX && devY >= devZ) {
          uniformRatio = ratioY;
        } else {
          uniformRatio = ratioZ;
        }

        // Apply uniform scale based on the starting scale
        const newUniformScale = transformStartScale.x * uniformRatio;
        selectedObject.scale.setScalar(newUniformScale);
      }
    }
  });
}

function onKeyDown(event) {
  if (modalManager.isModalOpen()) return;

  const transformControls = getTransformControls();

  switch (event.key.toLowerCase()) {
    case 'g':
      if (selectedObject) {
        transformControls.attach(selectedObject);
        transformControls.setMode('translate');
        hideGizmoMenu();
      }
      break;
    case 'r':
      if (selectedObject) {
        transformControls.attach(selectedObject);
        transformControls.setMode('rotate');
        hideGizmoMenu();
      }
      break;
    case 's':
      if (selectedObject) {
        transformControls.attach(selectedObject);
        transformControls.setMode('scale');
        hideGizmoMenu();
      }
      break;
    case 'delete':
    case 'backspace':
      if (selectedObject) {
        event.preventDefault();
        deleteSelectedFurniture();
      }
      break;
    case 'escape':
      deselectFurniture();
      break;
  }
}

function deleteSelectedFurniture() {
  if (!selectedObject) return;

  const scene = getScene();
  const command = new DeleteFurnitureCommand(scene, selectedObject, selectableObjects);
  undoManager.execute(command);

  deselectFurniture();
}

// Place furniture from database entry
export async function placeFurniture(entryId, position, surfaceNormal = null) {
  const entry = await getFurnitureEntry(entryId);
  if (!entry || !entry.model) {
    throw new Error('Furniture entry has no 3D model');
  }

  // Extract from ZIP and load with all assets
  const extractedData = await extractModelFromZip(entry.model);
  const model = await loadModelFromExtractedZip(extractedData);
  const scene = getScene();

  // Apply dimension-based scaling
  const scale = calculateFurnitureScale(model, entry);
  model.scale.copy(scale);

  // Set position
  if (position) {
    model.position.copy(position);
  }

  // Use provided surface normal or the last clicked surface normal
  const normal = surfaceNormal || lastClickSurfaceNormal || new THREE.Vector3(0, 1, 0);

  // For initial placement, use default contact axis (bottom of model)
  // This gives natural "standing" behavior for floor placement
  const contactAxis = DEFAULT_CONTACT_AXIS.clone();

  // Store surface info in userData for later rotation/dragging
  model.userData.surfaceNormal = normal.clone();
  model.userData.contactAxis = contactAxis;

  // Align furniture to surface (bottom against surface, upright)
  alignToSurface(model, normal, contactAxis);

  // Add to scene
  addFurnitureToScene(model, entryId, position);

  // Record undo action
  const command = new PlaceFurnitureCommand(scene, model, selectableObjects);
  undoManager.record(command);

  return model;
}

// Remove all furniture with a specific entry ID (when entry is deleted from database)
export function removeAllFurnitureByEntryId(entryId) {
  const scene = getScene();
  const toRemove = selectableObjects.filter(obj => obj.userData.entryId === entryId);

  toRemove.forEach(obj => {
    removeFurnitureFromScene(obj);
  });

  // Clear selection if selected object was removed
  if (selectedObject && toRemove.includes(selectedObject)) {
    deselectFurniture();
  }

  return toRemove.length;
}
