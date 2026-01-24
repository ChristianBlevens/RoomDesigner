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
const NORMAL_HISTORY_SIZE = 5;
let normalHistory = [];

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

// Gizmo menu element
let gizmoMenu = null;

/**
 * Align furniture to lay flat against a surface.
 * The furniture's local Y-axis (up) will align with the surface normal.
 * @param {THREE.Object3D} model - The furniture model
 * @param {THREE.Vector3} surfaceNormal - The surface normal vector
 * @param {number} rotationAroundNormal - Optional rotation around the normal (radians)
 */
function alignToSurface(model, surfaceNormal, rotationAroundNormal = 0) {
  // Default up vector for furniture (Y-up)
  const defaultUp = new THREE.Vector3(0, 1, 0);

  // Create quaternion to rotate from default up to surface normal
  const alignmentQuat = new THREE.Quaternion();
  alignmentQuat.setFromUnitVectors(defaultUp, surfaceNormal.clone().normalize());

  // Apply the alignment rotation
  model.quaternion.copy(alignmentQuat);

  // Apply additional rotation around the surface normal (for user adjustment)
  if (rotationAroundNormal !== 0) {
    const normalRotation = new THREE.Quaternion();
    normalRotation.setFromAxisAngle(surfaceNormal.clone().normalize(), rotationAroundNormal);
    model.quaternion.premultiply(normalRotation);
  }
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

  // Update stored rotation
  model.userData.rotationAroundNormal = (model.userData.rotationAroundNormal || 0) + deltaAngle;

  // Recompute orientation
  alignToSurface(
    model,
    model.userData.surfaceNormal,
    model.userData.rotationAroundNormal
  );
}

/**
 * Extract the rotation around the surface normal from an object's current quaternion.
 * This is used to preserve user rotation when starting a drag.
 * @param {THREE.Object3D} model - The furniture model
 * @returns {number} - Rotation around normal in radians
 */
function extractRotationAroundNormal(model) {
  const surfaceNormal = model.userData.surfaceNormal;
  if (!surfaceNormal) {
    // Fallback: extract Y rotation for floor-placed objects
    return model.rotation.y;
  }

  // Get the "base" alignment quaternion (just surface alignment, no around-normal rotation)
  const defaultUp = new THREE.Vector3(0, 1, 0);
  const baseQuat = new THREE.Quaternion();
  baseQuat.setFromUnitVectors(defaultUp, surfaceNormal.clone().normalize());

  // Get the current quaternion
  const currentQuat = model.quaternion.clone();

  // Calculate the "difference" quaternion: diffQuat = baseQuat.inverse() * currentQuat
  // This represents the rotation that was applied AFTER the base alignment
  const baseQuatInverse = baseQuat.clone().invert();
  const diffQuat = baseQuatInverse.multiply(currentQuat);

  // Extract the angle around the surface normal axis
  // The diffQuat should be a rotation around the Y axis (in local space, which aligns with surfaceNormal)
  // We can extract this by converting to axis-angle
  const axis = new THREE.Vector3();
  const angle = 2 * Math.acos(Math.min(1, Math.abs(diffQuat.w)));

  if (angle > 0.001) {
    // Get the rotation axis
    const sinHalfAngle = Math.sqrt(1 - diffQuat.w * diffQuat.w);
    if (sinHalfAngle > 0.001) {
      axis.set(
        diffQuat.x / sinHalfAngle,
        diffQuat.y / sinHalfAngle,
        diffQuat.z / sinHalfAngle
      );

      // Check if the axis is aligned with the surface normal (they should be parallel)
      // If axis is opposite to normal, negate the angle
      const dot = axis.dot(surfaceNormal.clone().normalize());
      if (dot < 0) {
        return -angle;
      }
      return angle;
    }
  }

  return 0;
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

    // Extract and store current rotation around normal BEFORE drag starts
    // This preserves any rotation applied by the 3D gizmo
    if (hit.object.userData.surfaceNormal) {
      const currentRotation = extractRotationAroundNormal(hit.object);
      hit.object.userData.rotationAroundNormal = currentRotation;
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
      // Move to new position on surface
      hoveredObject.position.copy(surfaceHit.point);

      // Use running average of normals for smooth alignment during drag
      const smoothedNormal = addNormalToHistory(surfaceHit.normal);

      // Update surface normal with smoothed value
      hoveredObject.userData.surfaceNormal = smoothedNormal.clone();

      // Re-align to new surface while preserving user rotation
      alignToSurface(
        hoveredObject,
        smoothedNormal,
        hoveredObject.userData.rotationAroundNormal || 0
      );
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
  hoveredObject = null;
  mouseDownPosition = null;
  dragStartPosition = null;
  clearNormalHistory();
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

  // Store surface info in userData for later rotation/dragging
  model.userData.surfaceNormal = normal.clone();
  model.userData.rotationAroundNormal = 0;

  // Align furniture to lay flat against the surface
  alignToSurface(model, normal, 0);

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
