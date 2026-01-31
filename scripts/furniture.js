// Furniture management and interaction for Room Furniture Planner

import * as THREE from 'three';
import {
  getScene,
  getRenderer,
  getCamera,
  getTransformControls,
  raycastFurniture,
  raycastFloor,
  raycastRoomSurface,
  addFurnitureToScene,
  removeFurnitureFromScene,
  loadModelFromExtractedZip,
  calculateFurnitureScale,
  selectableObjects,
  getRoomMesh,
  getRoomScale,
  updateFurnitureHitBox
} from './scene.js';
import {
  undoManager,
  PlaceFurnitureCommand,
  MoveFurnitureCommand,
  RotateFurnitureCommand,
  DeleteFurnitureCommand
} from './undo.js';
import { getFurnitureEntry } from './api.js';
import { modalManager } from './modals.js';
import { extractModelFromZip } from './utils.js';
import { isLightingDirectionMode, showActionNotification } from './main.js';

// Interaction state
let selectedObject = null;
let hoveredObject = null;
let isDragging = false;
let mouseDownPosition = null;
let dragStartPosition = null;
let activePointerId = null;

// Drag offset preservation (keeps grab point stable)
let dragOffset = new THREE.Vector3();

// Original orientation for surface transitions (prevents curved-edge corruption)
let dragStartQuaternion = new THREE.Quaternion();

// Drag plane for surface-constrained movement
let dragPlane = new THREE.Plane();
let dragPlaneRaycaster = new THREE.Raycaster();

// Surface raycast for snapping furniture to surface during drag
let surfaceRaycaster = new THREE.Raycaster();
let spawnSurfaceNormal = new THREE.Vector3(0, 1, 0); // The surface normal when furniture was placed
let lastValidPosition = new THREE.Vector3();
let lastValidNormal = new THREE.Vector3(0, 1, 0);

// Reusable vectors to avoid garbage collection
const _planeIntersect = new THREE.Vector3();
const _rayOrigin = new THREE.Vector3();
const _rayDir = new THREE.Vector3();

// Threshold for accepting surface normals (cosine of ~15°)
const SURFACE_NORMAL_TOLERANCE = 0.966; // cos(15°) ≈ 0.966

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
 * @param {THREE.Quaternion} quaternionOverride - Optional quaternion to use instead of model's current rotation
 * @returns {THREE.Vector3} Local axis that aligns with surface normal
 */
function detectContactAxis(model, surfaceNormal, quaternionOverride = null) {
  const quat = quaternionOverride || model.quaternion;
  let bestAxis = DEFAULT_CONTACT_AXIS.clone();
  let bestDot = -2;

  for (const localAxis of CARDINAL_AXES) {
    // Transform local axis to world space using the specified rotation
    const worldAxis = localAxis.clone().applyQuaternion(quat);

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
 * Calculate the offset needed to place the model so its bounding box face
 * sits on the surface. This accounts for the model's origin position
 * (models are bottom-center origin from server processing).
 *
 * @param {THREE.Object3D} model - The furniture model
 * @param {THREE.Vector3} surfaceNormal - Surface normal (world space)
 * @returns {number} Distance to offset along surface normal
 */
function calculateBoundingBoxOffset(model, surfaceNormal) {
  // Save current position and temporarily move to origin for local bbox calculation
  const savedPosition = model.position.clone();
  model.position.set(0, 0, 0);

  // Compute bounding box with model at origin (gives us local-space bounds)
  const box = new THREE.Box3().setFromObject(model);

  // Restore position
  model.position.copy(savedPosition);

  // Find the bounding box face that should touch the surface
  // If normal points positive on an axis, contact face is at box min
  // If normal points negative on an axis, contact face is at box max
  const contactPoint = new THREE.Vector3(
    surfaceNormal.x >= 0 ? box.min.x : box.max.x,
    surfaceNormal.y >= 0 ? box.min.y : box.max.y,
    surfaceNormal.z >= 0 ? box.min.z : box.max.z
  );

  // The offset is the distance from local origin (0,0,0) to contact face along the normal
  // Negative because we want to push the model AWAY from the surface
  const offset = -contactPoint.dot(surfaceNormal);

  return offset;
}

/**
 * Raycast from pointer to the drag plane.
 * @param {PointerEvent} event - Pointer event
 * @returns {THREE.Vector3|null} Intersection point or null
 */
function raycastDragPlane(event) {
  const canvas = getRenderer().domElement;
  const rect = canvas.getBoundingClientRect();

  const mouse = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );

  dragPlaneRaycaster.setFromCamera(mouse, getCamera());

  const intersects = dragPlaneRaycaster.ray.intersectPlane(dragPlane, _planeIntersect);
  return intersects ? _planeIntersect.clone() : null;
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

  // Pointer events (unified mouse + touch + pen)
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);

  // Prevent default touch behaviors on canvas
  canvas.style.touchAction = 'none';

  // Setup gizmo buttons
  setupGizmoButtons();

  // Setup transform controls events
  setupTransformControls();

  // Keyboard shortcuts
  window.addEventListener('keydown', onKeyDown);
}

function onPointerDown(event) {
  // Only handle primary pointer (left mouse button or first touch)
  if (!event.isPrimary) return;
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  if (modalManager.isModalOpen()) return;

  // Capture pointer for reliable tracking during drag
  event.target.setPointerCapture(event.pointerId);
  activePointerId = event.pointerId;

  mouseDownPosition = { x: event.clientX, y: event.clientY };

  // Check if clicking on furniture
  const hit = raycastFurniture(event);

  if (hit && hit.object) {
    hoveredObject = hit.object;
    dragStartPosition = hit.object.position.clone();

    // Calculate drag offset (difference between object center and grab point)
    dragOffset.copy(hit.object.position).sub(hit.point);

    // Save original quaternion for reference
    dragStartQuaternion.copy(hit.object.quaternion);

    // Store the spawn surface normal - this is the surface the furniture stays on
    spawnSurfaceNormal.copy(hit.object.userData.surfaceNormal || new THREE.Vector3(0, 1, 0));

    // Create drag plane at grab point, oriented to spawn surface
    dragPlane.setFromNormalAndCoplanarPoint(spawnSurfaceNormal, hit.point);

    // Initialize last valid state
    lastValidPosition.copy(hit.object.position);
    lastValidNormal.copy(spawnSurfaceNormal);

    // Clear normal history for fresh smoothing
    clearNormalHistory();

    // Capture contact axis based on current orientation
    if (hit.object.userData.surfaceNormal) {
      const currentContactAxis = detectContactAxis(hit.object, hit.object.userData.surfaceNormal);
      hit.object.userData.contactAxis = currentContactAxis;
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

function onPointerMove(event) {
  // Only track the active pointer
  if (activePointerId !== null && event.pointerId !== activePointerId) return;
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

    // Show immediate feedback
    showActionNotification('Moving furniture...');

    // Hide gizmo menu if visible (but transform controls weren't attached)
    hideGizmoMenu();
  }

  // Continue dragging - furniture slides on drag plane, raycasts to surface for snapping
  if (isDragging && hoveredObject) {
    // Raycast to drag plane for smooth sliding
    const planePoint = raycastDragPlane(event);
    if (!planePoint) return;

    // Calculate candidate position with drag offset
    const candidatePosition = planePoint.clone().add(dragOffset);

    // Raycast from candidate position toward the spawn surface to find actual surface point
    _rayOrigin.copy(candidatePosition);
    _rayDir.copy(spawnSurfaceNormal).negate(); // Ray goes toward surface (opposite of normal)

    // Offset ray origin slightly above the surface to avoid starting inside geometry
    _rayOrigin.add(spawnSurfaceNormal.clone().multiplyScalar(2));

    surfaceRaycaster.set(_rayOrigin, _rayDir);

    const roomMesh = getRoomMesh();
    if (!roomMesh) return;

    const intersects = surfaceRaycaster.intersectObject(roomMesh, true);

    if (intersects.length > 0) {
      const hit = intersects[0];
      const hitNormal = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize() : spawnSurfaceNormal.clone();

      // Check if the hit normal is within tolerance of spawn surface normal (~15°)
      if (hitNormal.dot(spawnSurfaceNormal) >= SURFACE_NORMAL_TOLERANCE) {
        // Valid surface - add to history for smoothing
        const smoothedNormal = addNormalToHistory(hitNormal);

        // Calculate bounding box offset to keep furniture on surface
        const bbOffset = calculateBoundingBoxOffset(hoveredObject, smoothedNormal);

        // Position furniture on the surface
        hoveredObject.position.copy(hit.point).add(
          smoothedNormal.clone().multiplyScalar(bbOffset)
        );

        // Update surface normal and alignment
        hoveredObject.userData.surfaceNormal = smoothedNormal.clone();

        // Keep contact axis aligned to smoothed normal
        const contactAxis = hoveredObject.userData.contactAxis || DEFAULT_CONTACT_AXIS;
        alignContactAxisToSurface(hoveredObject, smoothedNormal, contactAxis);
        applyUprightCorrection(hoveredObject, smoothedNormal);

        // Store as last valid state
        lastValidPosition.copy(hoveredObject.position);
        lastValidNormal.copy(smoothedNormal);
      } else {
        // Invalid surface (wall, etc.) - use last valid position
        hoveredObject.position.copy(lastValidPosition);
      }
    } else {
      // No hit - use last valid position
      hoveredObject.position.copy(lastValidPosition);
    }
  }
}

function onPointerUp(event) {
  // Only handle the active pointer
  if (activePointerId !== null && event.pointerId !== activePointerId) return;

  // Release pointer capture
  if (event.target.hasPointerCapture && event.target.hasPointerCapture(event.pointerId)) {
    event.target.releasePointerCapture(event.pointerId);
  }

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
      // Update hitbox position
      updateFurnitureHitBox(hoveredObject);
    }
    // Don't auto-select after drag - user can tap to select if needed
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
          showActionNotification('Opening furniture...');
          onOpenFurnitureModal();
        }
      }
    }
  }

  resetMouseState();
}

function onPointerCancel(event) {
  // Handle interruptions (incoming call, etc.)
  if (activePointerId !== null && event.pointerId !== activePointerId) return;

  if (event.target.hasPointerCapture && event.target.hasPointerCapture(event.pointerId)) {
    event.target.releasePointerCapture(event.pointerId);
  }

  resetMouseState();
}

function resetMouseState() {
  isDragging = false;
  mouseDownPosition = null;
  dragStartPosition = null;
  activePointerId = null;
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

  showActionNotification('Selected');
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
  const deleteBtn = document.getElementById('gizmo-delete-btn');

  const transformControls = getTransformControls();

  dragBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (selectedObject) {
      showActionNotification('Move mode');
      transformControls.attach(selectedObject);
      transformControls.setMode('translate');
    }
    hideGizmoMenu();
  });

  rotateBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (selectedObject) {
      showActionNotification('Rotate mode');
      transformControls.attach(selectedObject);
      transformControls.setMode('rotate');
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
          // Update hitbox position
          updateFurnitureHitBox(selectedObject);
        }
      } else if (mode === 'rotate') {
        const endRotation = selectedObject.rotation.clone();
        if (!transformStartRotation.equals(endRotation)) {
          undoManager.record(new RotateFurnitureCommand(
            selectedObject,
            transformStartRotation,
            endRotation
          ));
          // Update hitbox after rotation (AABB changes)
          updateFurnitureHitBox(selectedObject);
        }
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

  // Show immediate feedback
  showActionNotification('Deleting...');

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

  // Calculate base scale from entry dimensions and store it
  const baseScale = calculateFurnitureScale(model, entry);
  model.userData.baseScale = baseScale.clone();

  // Apply scale with room scale factor (multiplies each component)
  model.scale.copy(baseScale).multiplyScalar(getRoomScale());

  // Use provided surface normal or the last clicked surface normal
  const normal = surfaceNormal || lastClickSurfaceNormal || new THREE.Vector3(0, 1, 0);

  // Detect contact axis based on upright model's orientation relative to surface
  // This determines which face of the model touches the surface
  const contactAxis = detectContactAxis(model, normal);

  // Store surface info in userData for later rotation/dragging
  model.userData.surfaceNormal = normal.clone();
  model.userData.contactAxis = contactAxis;

  // Model stays in natural upright orientation - no rotation applied
  // User can manually rotate after placement, and drags will preserve that rotation

  // Set position with bounding box offset so contact face sits on surface
  if (position) {
    const bbOffset = calculateBoundingBoxOffset(model, normal);
    model.position.copy(position).add(normal.clone().multiplyScalar(bbOffset));
  }

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
