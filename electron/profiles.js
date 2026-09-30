'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// User-defined config profiles — persisted alongside app settings.
//
// These are custom "launch command profiles" the user creates from the UI.
// Each profile has: id, name, command (full docker run command), and createdAt.
// Used by matchProfileId in main.js so saved configs that exactly match a
// profile get loaded with that profile's name visible in the preset dropdown.
// ---------------------------------------------------------------------------

const DEFAULT_PROFILES = [];

/**
 * Load user-defined profiles from disk.
 * Returns an array of profile objects with { id, name, command, createdAt }.
 */
function loadProfiles(profilesPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    if (Array.isArray(raw)) {
      // Validate: each must have id, name, command
      return raw.filter(
        (p) =>
          p && typeof p.id === 'string' && p.id &&
          typeof p.name === 'string' && p.name &&
          typeof p.command === 'string' && p.command,
      );
    }
  } catch (_) { /* not yet created */ }
  return [...DEFAULT_PROFILES];
}

/**
 * Save profiles array to disk.
 * Returns { ok: true } or { ok: false, error: message }.
 */
function saveProfiles(profiles, profilesPath) {
  try {
    fs.mkdirSync(path.dirname(profilesPath), { recursive: true });
    fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Find a profile by id.
 */
function findProfile(profiles, id) {
  return profiles.find((p) => p.id === id) || null;
}

/**
 * Generate a unique profile id.
 */
function uniqueId() {
  return 'custom-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 8);
}

/**
 * Determine which profile (if any) matches the current launch command.
 * Compares the command (whitespace-normalised) against each profile's command.
 * Returns the profile id, or null if no match.
 */
function matchProfileId(profiles, command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const normalised = command.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  for (const profile of profiles) {
    const normalisedProfile = profile.command.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
    if (normalised === normalisedProfile) return profile.id;
  }
  return null;
}

module.exports = { loadProfiles, saveProfiles, findProfile, matchProfileId, uniqueId, DEFAULT_PROFILES };
