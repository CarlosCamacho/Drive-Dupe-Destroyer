<!-- Drive Dupe Destroyer v12.8 — VERSION-9.4-CHANGELOG.md -->
# Drive Dupe Destroyer v9.4 Changelog

## Release Date: January 2026

## Summary
This release focuses on improving the compare modal user experience, fixing several bugs, and adding keyboard shortcuts for faster workflow.

---

## New Features

### 1. Keyboard Shortcuts in Compare Modal
- **Press `1`**: Delete the left image
- **Press `2`**: Delete the right image  
- **Press `3`**: Delete both images
- **Arrow keys**: Navigate between groups (← Prev, → Next)
- **Escape**: Close the modal

### 2. Download Links in Compare Modal
- Added "Download" link next to "Open in Drive" for each image
- Click to download the file directly to your computer

### 3. Auto-Advance After Delete
- After deleting an image in the modal, automatically advances to the next group
- Streamlines the review workflow significantly

### 4. Filter Statistics
- When changing the similarity filter (≥90%, ≥75%, ≥50%), now shows the number of matching groups and files
- Helps understand how many duplicates match each similarity threshold

### 5. Visual Group Separation
- Added clear visual separation between duplicate groups in the results list
- Groups now have a top border and margin to make them easier to distinguish
- Makes scanning through results much clearer

---

## Bug Fixes

### 1. Fixed "Trash Selected" Count Reset Bug
- **Issue**: The count in "Trash Selected (N)" would reset as you scrolled through the virtual-scrolled list
- **Fix**: Selection count now properly tracks from the internal selection Set, not DOM checkboxes
- You can now select 30+ images and the count will remain accurate

### 2. Fixed Keep Image Positioning
- **Issue**: When using "Highest resolution" keep rule, the higher resolution image wasn't always on the left
- **Fix**: The keep file is now consistently displayed on the left side of the compare modal

---

## UI Improvements

### 1. Larger Fonts in Compare Modal
- Increased file name font size from 0.9rem to 1.1rem
- Increased metadata font size from 0.8rem to 0.95rem
- Increased KEEP badge size
- Increased button sizes in modal actions

### 2. Simplified Modal Interface
- Removed "Select" checkbox buttons (not needed in modal context)
- Removed "Show/Hide Difference" feature (user feedback indicated it wasn't helpful)
- Removed modal footer (cleaner appearance)
- Delete buttons now simply say "Delete" instead of "🗑️ Delete"

### 3. No Delete Confirmation
- Clicking Delete now moves to trash immediately without asking "Move to Trash?"
- Speeds up the review process
- Toast notification confirms the action

### 4. Keyboard Hint in Modal Header
- Shows available keyboard shortcuts in the modal header
- Hidden on smaller screens to save space

---

## Technical Changes

- Updated version to 9.4 across all files
- Added `getSelectedCount()` export from render.js
- Added `setSelectedCountProvider()` in ui.js for dependency injection
- Added `updateFilterStats()` function for filter statistics
- Modal keyboard handler properly added/removed on open/close
- CSS improvements for group separation and modal layout

---

## Files Modified

- `index.html` - Modal structure updates, added filter stats span
- `js/app.js` - Wire up selected count provider
- `js/compare.js` - Keyboard shortcuts, download, auto-advance, no confirmation
- `js/render.js` - Export selected count, group separation, filter stats
- `js/ui.js` - Selected count provider, filter stats function
- `styles.css` - Larger modal fonts, group separation, keyboard hint
- `sw.js` - Version update

---

## Migration Notes

No breaking changes. Simply replace your v9.3 folder with v9.4.
