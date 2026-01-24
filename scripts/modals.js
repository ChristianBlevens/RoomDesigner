// Modal management for Room Furniture Planner

class ModalManager {
  constructor() {
    this.activeModal = null;
    this.modalStack = [];
    this.justOpened = false; // Flag to prevent immediate closure
    this.setupGlobalListener();
  }

  setupGlobalListener() {
    document.addEventListener('click', (event) => {
      if (!this.activeModal) return;

      // Prevent closing modal on the same click that opened it
      if (this.justOpened) {
        this.justOpened = false;
        return;
      }

      // Don't close if clicking on action popups (they're outside modal but related)
      const entryPopup = document.getElementById('entry-action-popup');
      if (entryPopup && entryPopup.contains(event.target)) {
        return;
      }
      const housePopup = document.getElementById('house-action-popup');
      if (housePopup && housePopup.contains(event.target)) {
        return;
      }
      // Don't close if clicking on error popup
      const errorPopup = document.getElementById('error-popup');
      if (errorPopup && errorPopup.contains(event.target)) {
        return;
      }

      // Don't close if clicking on a modal that should stay open
      const modal = this.activeModal;
      const modalContent = modal.querySelector('.modal-content');
      const isOutsideModal = modalContent && !modalContent.contains(event.target);

      // Special case: certain modals shouldn't close on outside click
      if ((modal.id === 'initial-modal' || modal.id === 'orientation-modal' || modal.id === 'calendar-modal') && isOutsideModal) {
        return;
      }

      if (isOutsideModal) {
        this.closeModal();
      }
    }, true);
  }

  openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;

    // If there's an active modal, push it to stack (for sub-modals)
    // Keep the parent modal visible behind the new modal
    if (this.activeModal && this.activeModal.id !== modalId) {
      this.modalStack.push(this.activeModal);
      // Don't hide parent modal - let it stay visible behind
    }

    modal.classList.remove('modal-hidden');
    this.activeModal = modal;
    this.justOpened = true; // Set flag to prevent immediate closure
  }

  closeModal() {
    if (!this.activeModal) return;

    // Don't allow closing the calendar modal via closeModal (use closeAllModals when loading a house)
    if (this.activeModal.id === 'calendar-modal' && this.modalStack.length === 0) {
      return;
    }

    this.activeModal.classList.add('modal-hidden');

    // If there's a parent modal in stack, restore it as active
    // (parent is already visible since we don't hide it)
    if (this.modalStack.length > 0) {
      this.activeModal = this.modalStack.pop();
    } else {
      this.activeModal = null;
    }
  }

  closeAllModals() {
    while (this.activeModal) {
      this.activeModal.classList.add('modal-hidden');
      this.activeModal = this.modalStack.pop() || null;
    }
    this.modalStack = [];
  }

  isModalOpen() {
    return this.activeModal !== null;
  }

  getActiveModal() {
    return this.activeModal;
  }
}

export const modalManager = new ModalManager();

// Multi-select tags dropdown component
export class MultiSelectTags {
  constructor(containerId, onChangeCallback) {
    this.container = document.getElementById(containerId);
    this.onChangeCallback = onChangeCallback;
    this.allTags = [];
    this.selectedTags = new Set();
    this.isOpen = false;

    this.render();
    this.setupOutsideClick();
  }

  setTags(tags) {
    this.allTags = tags.sort();
    this.render();
  }

  render() {
    this.container.innerHTML = `
      <div class="multi-select-wrapper">
        <div class="multi-select-display" id="ms-display-${this.container.id}">
          <span class="ms-placeholder">${this.getPlaceholderText()}</span>
          <span class="ms-arrow">▼</span>
        </div>
        <div class="multi-select-dropdown ${this.isOpen ? 'open' : ''}" id="ms-dropdown-${this.container.id}">
          <div class="ms-search">
            <input type="text" placeholder="Search tags..." id="ms-search-${this.container.id}">
          </div>
          <div class="ms-options" id="ms-options-${this.container.id}">
            ${this.renderOptions()}
          </div>
          <div class="ms-actions">
            <button type="button" class="ms-clear">Clear All</button>
          </div>
        </div>
      </div>
    `;

    this.attachEvents();
  }

  getPlaceholderText() {
    if (this.selectedTags.size === 0) {
      return 'Select tags...';
    }
    return Array.from(this.selectedTags).join(', ');
  }

  renderOptions(filter = '') {
    const filteredTags = filter
      ? this.allTags.filter(tag => tag.toLowerCase().includes(filter.toLowerCase()))
      : this.allTags;

    if (filteredTags.length === 0) {
      return '<div style="padding: 12px; color: #6b7280; text-align: center;">No tags found</div>';
    }

    return filteredTags.map(tag => `
      <label class="ms-option">
        <input type="checkbox" value="${tag}" ${this.selectedTags.has(tag) ? 'checked' : ''}>
        <span>${tag}</span>
      </label>
    `).join('');
  }

  attachEvents() {
    const display = document.getElementById(`ms-display-${this.container.id}`);
    const dropdown = document.getElementById(`ms-dropdown-${this.container.id}`);
    const searchInput = document.getElementById(`ms-search-${this.container.id}`);
    const optionsContainer = document.getElementById(`ms-options-${this.container.id}`);
    const clearBtn = this.container.querySelector('.ms-clear');

    // Toggle dropdown
    display.addEventListener('click', (e) => {
      e.stopPropagation();
      this.isOpen = !this.isOpen;
      dropdown.classList.toggle('open', this.isOpen);
    });

    // Search filter
    searchInput.addEventListener('input', (e) => {
      optionsContainer.innerHTML = this.renderOptions(e.target.value);
      this.attachCheckboxEvents();
    });

    // Prevent clicks inside dropdown from closing it
    dropdown.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    // Clear all
    clearBtn.addEventListener('click', () => {
      this.selectedTags.clear();
      this.updateDisplay();
      this.render();
      this.onChangeCallback(Array.from(this.selectedTags));
    });

    this.attachCheckboxEvents();
  }

  attachCheckboxEvents() {
    const checkboxes = this.container.querySelectorAll('.ms-option input[type="checkbox"]');
    checkboxes.forEach(checkbox => {
      checkbox.addEventListener('change', (e) => {
        if (e.target.checked) {
          this.selectedTags.add(e.target.value);
        } else {
          this.selectedTags.delete(e.target.value);
        }
        this.updateDisplay();
        this.onChangeCallback(Array.from(this.selectedTags));
      });
    });
  }

  updateDisplay() {
    const placeholder = this.container.querySelector('.ms-placeholder');
    if (placeholder) {
      placeholder.textContent = this.getPlaceholderText();
    }
  }

  setupOutsideClick() {
    document.addEventListener('click', (e) => {
      if (!this.container.contains(e.target) && this.isOpen) {
        this.isOpen = false;
        const dropdown = document.getElementById(`ms-dropdown-${this.container.id}`);
        if (dropdown) dropdown.classList.remove('open');
      }
    });
  }

  getSelectedTags() {
    return Array.from(this.selectedTags);
  }

  clearSelection() {
    this.selectedTags.clear();
    this.updateDisplay();
    this.render();
  }
}
