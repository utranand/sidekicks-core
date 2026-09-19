// office-viz shared theme renderer — the agent office as a configurable voxel world. Same simulation
// contract and behavior as the shared office simulation (rooms from the config template, desks
// from DATA.agents, the same officer state machine and SSE diffing) reskinned in
// blocks: pixel-noise canvas textures (NearestFilter), box-only geometry, Steve-style
// blocky officers with face textures, floating state blocks instead of plumbobs,
// glowstone lamps, torches, a square sun/moon, and boxy clouds.
// Contract: registers window.OFFICE_THEMES[<name>] = { label, boot(ctx) }.
//   ctx.data — the OFFICE_DATA payload (agents, counts, config).
//   boot() builds the scene into the fixed page DOM (#scene, #office, #tip, #panel,
//   .ctl buttons) and returns { applyPayload(payload) } for live SSE updates
//   (or undefined when WebGL is unavailable). Shared HUD counts /
//   SSE wiring / theme selector live in the page runtime, not in themes.
(function () {
  'use strict';

  var THEME = window.__OFFICE_VIZ_THEME_CONFIG || {};
  window.__OFFICE_VIZ_THEME_CONFIG = null;

  function themeValue(path, fallback) {
    var cur = THEME;
    var parts = path.split('.');
    for (var i = 0; i < parts.length; i++) {
      if (!cur || typeof cur !== 'object' || !(parts[i] in cur)) return fallback;
      cur = cur[parts[i]];
    }
    return cur == null ? fallback : cur;
  }

  function themeArray(path, fallback) {
    var value = themeValue(path, fallback);
    return Array.isArray(value) ? value : fallback;
  }

  function themeObject(path, fallback) {
    var value = themeValue(path, fallback);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
    var merged = {};
    Object.keys(fallback || {}).forEach(function (key) { merged[key] = fallback[key]; });
    Object.keys(value).forEach(function (key) { merged[key] = value[key]; });
    return merged;
  }

  class DefaultOfficeTheme {
    constructor(ctx) {
      this.ctx = ctx;
    }

    boot() {
      var ctx = this.ctx;
      var DATA = ctx.data;
      var CFG = DATA.config || {};
      var sceneEl = document.getElementById('scene');
      var canvas = document.getElementById('office');
      var tipEl = document.getElementById('tip');
      var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      var renderer;
      try {
        renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
      } catch (e) {
        canvas.remove();
        var msg = document.createElement('div');
        msg.className = 'nogl';
        msg.textContent = 'WebGL is unavailable in this browser — the 3D office needs it.';
        sceneEl.appendChild(msg);
        return;
      }
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.outputEncoding = THREE.sRGBEncoding;
