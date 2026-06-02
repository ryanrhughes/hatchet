// Hatchet for Fizzy - Content Script
// Injects a Hatchet button into Fizzy card pages

(function() {
  'use strict';

  // Check if we're on a card page
  function isCardPage() {
    return /\/cards\/\d+/.test(window.location.pathname);
  }

  // Extract card number from URL
  function getCardNumber() {
    const match = window.location.pathname.match(/\/cards\/(\d+)/);
    return match ? match[1] : null;
  }

  // Extract board ID and name from back button
  function getBoardInfo() {
    const backLink = document.querySelector('.btn--back');
    if (!backLink) return null;

    const href = backLink.getAttribute('href');
    const boardMatch = href?.match(/\/boards\/([^\/]+)/);
    const boardId = boardMatch ? boardMatch[1] : null;

    const nameEl = backLink.querySelector('strong');
    const boardName = nameEl?.textContent?.replace('Back to ', '') || 'Unknown Board';

    return { boardId, boardName };
  }

  // Create the Hatchet button
  function createHatchetButton() {
    const button = document.createElement('button');
    button.className = 'btn hatchet-btn';
    button.setAttribute('data-controller', 'tooltip');
    button.setAttribute('type', 'button');
    // Use the same structure as Fizzy's icons: span.icon with the icon class
    // But since we're using inline SVG, we need to match Fizzy's icon sizing
    button.innerHTML = `
      <span class="icon hatchet-icon" aria-hidden="true"></span>
      <span class="for-screen-reader">Open in Hatchet</span>
    `;
    
    button.addEventListener('click', handleHatchetClick);
    return button;
  }

  // Handle click on Hatchet button
  async function handleHatchetClick(e) {
    e.preventDefault();
    
    const cardNumber = getCardNumber();
    const boardInfo = getBoardInfo();
    
    if (!cardNumber || !boardInfo?.boardId) {
      showNotification('Could not detect card or board information', 'error');
      return;
    }

    // Get stored path for this board
    const result = await chrome.storage.local.get(['boardPaths']);
    const boardPaths = result.boardPaths || {};
    let projectPath = boardPaths[boardInfo.boardId];

    if (!projectPath) {
      // Prompt user for path
      projectPath = await promptForPath(boardInfo);
      if (!projectPath) return; // User cancelled
      
      // Save the path
      boardPaths[boardInfo.boardId] = projectPath;
      await chrome.storage.local.set({ boardPaths });
    }

    // Build the hatchet:// URL
    const hatchetUrl = buildHatchetUrl(cardNumber, projectPath);
    
    // Open the URL (triggers protocol handler)
    window.location.href = hatchetUrl;
  }

  // Build hatchet:// protocol URL
  function buildHatchetUrl(cardNumber, projectPath) {
    const params = new URLSearchParams({
      path: projectPath,
      'launch-ai': 'true',
      'with-context': 'true'
    });
    return `hatchet://card/${cardNumber}?${params.toString()}`;
  }

  // Prompt user for project path
  async function promptForPath(boardInfo) {
    return new Promise((resolve) => {
      // Create modal overlay
      const overlay = document.createElement('div');
      overlay.className = 'hatchet-modal-overlay';
      
      const modal = document.createElement('div');
      modal.className = 'hatchet-modal';
      modal.innerHTML = `
        <div class="hatchet-modal-header">
          <h3>Configure Hatchet</h3>
          <button class="hatchet-modal-close">&times;</button>
        </div>
        <div class="hatchet-modal-body">
          <p>Enter the project path for <strong>${boardInfo.boardName}</strong>:</p>
          <input type="text" class="hatchet-path-input" placeholder="/home/user/projects/myproject" autofocus>
          <p class="hatchet-hint">This is the root directory of your git repository.</p>
        </div>
        <div class="hatchet-modal-footer">
          <button class="hatchet-btn-cancel">Cancel</button>
          <button class="hatchet-btn-save">Save & Open</button>
        </div>
      `;

      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      const input = modal.querySelector('.hatchet-path-input');
      const closeBtn = modal.querySelector('.hatchet-modal-close');
      const cancelBtn = modal.querySelector('.hatchet-btn-cancel');
      const saveBtn = modal.querySelector('.hatchet-btn-save');

      const cleanup = () => {
        overlay.remove();
      };

      closeBtn.addEventListener('click', () => {
        cleanup();
        resolve(null);
      });

      cancelBtn.addEventListener('click', () => {
        cleanup();
        resolve(null);
      });

      saveBtn.addEventListener('click', () => {
        const path = input.value.trim();
        if (path) {
          cleanup();
          resolve(path);
        } else {
          input.classList.add('hatchet-input-error');
          input.focus();
        }
      });

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          saveBtn.click();
        } else if (e.key === 'Escape') {
          cleanup();
          resolve(null);
        }
        input.classList.remove('hatchet-input-error');
      });

      // Focus input after a tick
      setTimeout(() => input.focus(), 0);
    });
  }

  // Show notification toast
  function showNotification(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `hatchet-toast hatchet-toast--${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    
    setTimeout(() => {
      toast.classList.add('hatchet-toast--visible');
    }, 10);

    setTimeout(() => {
      toast.classList.remove('hatchet-toast--visible');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // Insert the Hatchet button into the page
  function insertHatchetButton() {
    // Check if button already exists
    if (document.querySelector('.hatchet-btn')) return;

    // Find the right actions container
    const actionsRight = document.querySelector('.card-perma__actions--right');
    if (!actionsRight) return;

    // Create a wrapper div like the other buttons
    const wrapper = document.createElement('div');
    wrapper.className = 'hatchet-btn-wrapper';
    wrapper.appendChild(createHatchetButton());

    // Insert at the beginning of the actions
    actionsRight.insertBefore(wrapper, actionsRight.firstChild);
  }

  // Initialize
  function init() {
    if (!isCardPage()) return;

    // Try to insert immediately
    insertHatchetButton();

    // Also observe for DOM changes (Turbo navigation)
    const observer = new MutationObserver((mutations) => {
      if (isCardPage() && !document.querySelector('.hatchet-btn')) {
        insertHatchetButton();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  // Run on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Also run on Turbo navigation
  document.addEventListener('turbo:load', init);
  document.addEventListener('turbo:render', init);
})();
