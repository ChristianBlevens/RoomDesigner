// Undo/Redo system using Command pattern

import { createFurnitureHitBox, removeFurnitureHitBox, updateFurnitureHitBox } from './scene.js';

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
  }

  undo() {
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
  }

  execute() {
    this.model.position.copy(this.toPosition);
    updateFurnitureHitBox(this.model);
  }

  undo() {
    this.model.position.copy(this.fromPosition);
    updateFurnitureHitBox(this.model);
  }
}

// Command: Rotate furniture
export class RotateFurnitureCommand {
  constructor(model, fromRotation, toRotation) {
    this.model = model;
    this.fromRotation = fromRotation.clone();
    this.toRotation = toRotation.clone();
  }

  execute() {
    this.model.rotation.copy(this.toRotation);
    updateFurnitureHitBox(this.model);
  }

  undo() {
    this.model.rotation.copy(this.fromRotation);
    updateFurnitureHitBox(this.model);
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
