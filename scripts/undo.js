// Undo/Redo system using Command pattern

import { createFurnitureHitBox, removeFurnitureHitBox, updateFurnitureHitBox, selectableObjects } from './scene.js';

class UndoManager {
  constructor(maxHistory = 50) {
    this.undoStack = [];
    this.redoStack = [];
    this.maxHistory = maxHistory;
  }

  execute(command) {
    command.execute();
    this.undoStack.push(command);
    this.redoStack = [];

    // Limit history size
    if (this.undoStack.length > this.maxHistory) {
      this.undoStack.shift();
    }

    this.updateButtons();
  }

  // Record a command without executing it (for actions already performed)
  record(command) {
    this.undoStack.push(command);
    this.redoStack = [];

    if (this.undoStack.length > this.maxHistory) {
      this.undoStack.shift();
    }

    this.updateButtons();
  }

  undo() {
    if (this.undoStack.length === 0) return;

    const command = this.undoStack.pop();
    command.undo();
    this.redoStack.push(command);

    this.updateButtons();
  }

  redo() {
    if (this.redoStack.length === 0) return;

    const command = this.redoStack.pop();
    command.execute();
    this.undoStack.push(command);

    this.updateButtons();
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  updateButtons() {
    const undoBtn = document.getElementById('undo-btn');
    const redoBtn = document.getElementById('redo-btn');
    if (undoBtn) undoBtn.disabled = !this.canUndo();
    if (redoBtn) redoBtn.disabled = !this.canRedo();
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
    this.updateButtons();
  }
}

// Command: Place furniture
export class PlaceFurnitureCommand {
  constructor(scene, model, selectableObjects) {
    this.scene = scene;
    this.model = model;
    this.selectableObjects = selectableObjects;
    this.position = model.position.clone();
    this.rotation = model.rotation.clone();
    this.scale = model.scale.clone();
    this.isChild = !!model.userData.isChild;
    this.parentUuid = model.userData.parentId || null;
  }

  execute() {
    this.model.position.copy(this.position);
    this.model.rotation.copy(this.rotation);
    this.model.scale.copy(this.scale);
    this.scene.add(this.model);
    if (!this.selectableObjects.includes(this.model)) {
      this.selectableObjects.push(this.model);
    }
    // Recreate hitbox if it was removed
    if (!this.model.userData.hitBox) {
      createFurnitureHitBox(this.model);
    }
    // Re-link to parent if this is a child being re-added
    if (this.isChild && this.parentUuid) {
      const parent = this.selectableObjects.find(obj => obj.uuid === this.parentUuid);
      if (parent) {
        if (!parent.userData.childIds) parent.userData.childIds = [];
        if (!parent.userData.childIds.includes(this.model.uuid)) {
          parent.userData.childIds.push(this.model.uuid);
        }
      }
    }
  }

  undo() {
    // Unlink from parent if this is a child
    if (this.isChild && this.parentUuid) {
      const parent = this.selectableObjects.find(obj => obj.uuid === this.parentUuid);
      if (parent && parent.userData.childIds) {
        const idx = parent.userData.childIds.indexOf(this.model.uuid);
        if (idx > -1) parent.userData.childIds.splice(idx, 1);
      }
    }
    // Remove hitbox before removing model
    removeFurnitureHitBox(this.model);
    this.scene.remove(this.model);
    const index = this.selectableObjects.indexOf(this.model);
    if (index > -1) this.selectableObjects.splice(index, 1);
  }
}

// Command: Move furniture
export class MoveFurnitureCommand {
  constructor(model, fromPosition, toPosition) {
    this.model = model;
    this.fromPosition = fromPosition.clone();
    this.toPosition = toPosition.clone();
    // Snapshot child positions at construction time (before state)
    this.childFromStates = [];
    const childIds = model.userData.childIds || [];
    for (const childId of childIds) {
      const child = selectableObjects.find(obj => obj.uuid === childId);
      if (child) {
        this.childFromStates.push({
          model: child,
          fromPosition: child.position.clone(),
          toPosition: null
        });
      }
    }
  }

  captureChildEndPositions() {
    for (const cs of this.childFromStates) {
      cs.toPosition = cs.model.position.clone();
    }
  }

  execute() {
    this.model.position.copy(this.toPosition);
    updateFurnitureHitBox(this.model);
    for (const cs of this.childFromStates) {
      if (cs.toPosition) {
        cs.model.position.copy(cs.toPosition);
        updateFurnitureHitBox(cs.model);
      }
    }
  }

  undo() {
    this.model.position.copy(this.fromPosition);
    updateFurnitureHitBox(this.model);
    for (const cs of this.childFromStates) {
      cs.model.position.copy(cs.fromPosition);
      updateFurnitureHitBox(cs.model);
    }
  }
}

// Command: Rotate furniture
export class RotateFurnitureCommand {
  constructor(model, fromRotation, toRotation) {
    this.model = model;
    this.fromRotation = fromRotation.clone();
    this.toRotation = toRotation.clone();
    // Snapshot child states at construction time (before state)
    this.childFromStates = [];
    const childIds = model.userData.childIds || [];
    for (const childId of childIds) {
      const child = selectableObjects.find(obj => obj.uuid === childId);
      if (child) {
        this.childFromStates.push({
          model: child,
          fromPosition: child.position.clone(),
          fromRotation: child.rotation.clone(),
          toPosition: null,
          toRotation: null
        });
      }
    }
  }

  captureChildEndRotations() {
    for (const cs of this.childFromStates) {
      cs.toPosition = cs.model.position.clone();
      cs.toRotation = cs.model.rotation.clone();
    }
  }

  execute() {
    this.model.rotation.copy(this.toRotation);
    updateFurnitureHitBox(this.model);
    for (const cs of this.childFromStates) {
      if (cs.toPosition) {
        cs.model.position.copy(cs.toPosition);
        cs.model.rotation.copy(cs.toRotation);
        updateFurnitureHitBox(cs.model);
      }
    }
  }

  undo() {
    this.model.rotation.copy(this.fromRotation);
    updateFurnitureHitBox(this.model);
    for (const cs of this.childFromStates) {
      cs.model.position.copy(cs.fromPosition);
      cs.model.rotation.copy(cs.fromRotation);
      updateFurnitureHitBox(cs.model);
    }
  }
}

// Command: Scale furniture
export class ScaleFurnitureCommand {
  constructor(model, fromScale, toScale) {
    this.model = model;
    this.fromScale = fromScale.clone();
    this.toScale = toScale.clone();
  }

  execute() {
    this.model.scale.copy(this.toScale);
    updateFurnitureHitBox(this.model);
  }

  undo() {
    this.model.scale.copy(this.fromScale);
    updateFurnitureHitBox(this.model);
  }
}

// Command: Delete furniture
export class DeleteFurnitureCommand {
  constructor(scene, model, selectableObjects) {
    this.scene = scene;
    this.model = model;
    this.selectableObjects = selectableObjects;
    this.position = model.position.clone();
    this.rotation = model.rotation.clone();
    this.scale = model.scale.clone();
  }

  execute() {
    // Remove hitbox before removing model
    removeFurnitureHitBox(this.model);
    this.scene.remove(this.model);
    const index = this.selectableObjects.indexOf(this.model);
    if (index > -1) this.selectableObjects.splice(index, 1);
  }

  undo() {
    this.model.position.copy(this.position);
    this.model.rotation.copy(this.rotation);
    this.model.scale.copy(this.scale);
    this.scene.add(this.model);
    if (!this.selectableObjects.includes(this.model)) {
      this.selectableObjects.push(this.model);
    }
    // Recreate hitbox for the restored model
    if (!this.model.userData.hitBox) {
      createFurnitureHitBox(this.model);
    }
  }
}

// Global undo manager instance
export const undoManager = new UndoManager();
