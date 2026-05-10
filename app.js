'use strict';

const { App }    = require('homey');
const { HomeyAPI } = require('homey-api');

class EasyAutomationApp extends App {

  //  Lifecycle 

  async onInit() {
    const manifest = this.homey.manifest;
    this.log(`Easy Automation v${manifest.version} starting...`);

    this._log            = [];
    this._logSaveTimer   = null;
    this._capInstances   = [];     // CapabilityInstance objects — keep refs so GC doesn't destroy subscriptions
    this._holdTimers     = new Map();
    this._safetyTimers   = new Map();
    this._overrideTimers = new Map();
    this._minuteTimer    = null;
    this._reconnectTimer = null;
    this._cachedDevices  = [];
    this._api            = null;   // single shared HomeyAPI instance for all queries/actions
    this._listenerApi    = null;
    this._liveDevices    = null;   // live device map reused across triggers to avoid repeated getDevices() calls

    // Cache all devices now (API handlers have limited homey access)
    await this._refreshDeviceCache();

    // Watch for settings changes from the settings page
    this.homey.settings.on('set', key => {
      if (key === 'automations') {
        this._addLog('info', 'Automations updated — re-attaching listeners');
        this._detachAllListeners();
        this._attachAllListeners().catch(e =>
          this._addLog('error', 'Re-attach after settings change: ' + e.message)
        );
      }
      if (key === '_refreshDevices') {
        this._addLog('info', 'Device refresh requested from settings page');
        this._refreshDeviceCache();
      }
      if (key === '_testRequest') {
        this._runTestRequest().catch(e =>
          this._addLog('error', 'testRequest: ' + e.message)
        );
      }
      if (key === '_flowTriggersReq') {
        this._runFlowTriggersRequest().catch(e =>
          this._addLog('error', 'flowTriggersReq: ' + e.message)
        );
      }
      if (key === '_ovLearnReq') {
        this._runOvLearnRequest().catch(e =>
          this._addLog('error', 'ovLearnReq: ' + e.message)
        );
      }
      if (key === '_flowSyncReq') {
        this._runFlowSyncRequest().catch(e =>
          this._addLog('error', 'flowSyncReq: ' + e.message)
        );
      }
      if (key === '_flowCheckReq') {
        this._runFlowCheckRequest().catch(e =>
          this._addLog('error', 'flowCheckReq: ' + e.message)
        );
      }
      if (key === '_flowActionCardsReq') {
        this._runFlowActionCardsRequest().catch(e =>
          this._addLog('error', 'flowActionCardsReq: ' + e.message)
        );
      }
      if (key === '_previewReq') {
        this._runPreviewRequest().catch(e =>
          this._addLog('error', 'previewReq: ' + e.message)
        );
      }
    });

    // Flow action: "Run automation group"
    const runGroupCard = this.homey.flow.getActionCard('run_group');
    runGroupCard.registerArgumentAutocompleteListener('group', async query => {
      const groups = this._getGroups();
      return groups
        .filter(g => g.name.toLowerCase().includes(query.toLowerCase()))
        .map(g => ({ id: g.id, name: g.name, description: g.type }));
    });
    runGroupCard.registerRunListener(async args => {
      const groupId = args.group.id;
      this._addLog('trigger', `Flow action "run_group" → group "${args.group.name}"`);
      const offTypes = new Set(['motion_stop', 'door_close', 'switch_off']);
      const automations = this._getAutomations().filter(
        a => a._groupId === groupId && a.enabled !== false
      );
      const target = automations.find(a => !a.trigger || !offTypes.has(a.trigger.type)) || automations[0];
      if (!target) throw new Error(`Automation group not found: ${groupId}`);
      await this._runActions(target.actions || [], target.name);
    });

    // Flow action: "Override automation group"
    const overrideGroupCard = this.homey.flow.getActionCard('override_group');
    overrideGroupCard.registerArgumentAutocompleteListener('group', async query => {
      const groups = this._getGroups();
      return groups
        .filter(g => (g.type === 'motion_lights' || g.type === 'smart_dim') &&
                     g.name.toLowerCase().includes(query.toLowerCase()))
        .map(g => ({ id: g.id, name: g.name, description: g.type }));
    });
    overrideGroupCard.registerRunListener(async args => {
      const groupId = args.group.id;
      this._addLog('trigger', `Flow action "override_group" → group "${args.group.name}"`);
      const auto = this._getAutomations().find(a =>
        (a._groupId || a.id) === groupId && a._overrideSwitch
      );
      const ov = auto && auto._overrideSwitch;
      await this._doOverride(groupId, ov ? ov.brightness : 1, ov ? ov.durationMinutes : 60);
    });

    // Flow action: "Cancel override for automation group"
    const cancelOverrideCard = this.homey.flow.getActionCard('cancel_override');
    cancelOverrideCard.registerArgumentAutocompleteListener('group', async query => {
      const groups = this._getGroups();
      return groups
        .filter(g => (g.type === 'motion_lights' || g.type === 'smart_dim') &&
                     g.name.toLowerCase().includes(query.toLowerCase()))
        .map(g => ({ id: g.id, name: g.name, description: g.type }));
    });
    cancelOverrideCard.registerRunListener(async args => {
      const groupId = args.group.id;
      this._addLog('trigger', `Flow action "cancel_override" → group "${args.group.name}"`);
      await this._cancelOverride(groupId);
    });

    // Never let listener setup crash the app startup
    try {
      await this._attachAllListeners();
    } catch (e) {
      this.error('_attachAllListeners failed (non-fatal):', e.message);
    }

    this.log('Easy Automation ready');
  }

  async onUninit() {
    this._detachAllListeners();
  }

  //  Shared API helper

  async _getApi() {
    if (!this._api) {
      this._api = await HomeyAPI.createAppAPI({ homey: this.homey });
    }
    return this._api;
  }

  //  Catch-all API handler

  async onApi(method, path, body) {
    const p = path.replace(/^\//, '');

    if (method === 'GET' && p === 'devices') {
      return this._cachedDevices;
    }
    if (method === 'GET' && p === 'automations') {
      return this._getAutomations();
    }
    if (method === 'POST' && p === 'automations') {
      const automations = Array.isArray(body) ? body : (body && body.automations);
      if (!Array.isArray(automations)) throw new Error('Expected an array');
      this.homey.settings.set('automations', JSON.stringify(automations));
      this._addLog('info', `Saved ${automations.length} automation(s)`);
      this._detachAllListeners();
      await this._attachAllListeners().catch(e =>
        this._addLog('error', 'Re-attach after save: ' + e.message)
      );
      return { ok: true, count: automations.length };
    }
    if (method === 'POST' && p === 'test') {
      const automation = body && body.automation;
      if (!automation) throw new Error('No automation supplied');
      this._addLog('test', `Manual test: "${automation.name}"`);
      const results = await this._runActions(automation.actions || [], `TEST:"${automation.name}"`);
      return { ok: true, results };
    }
    if (method === 'GET' && p === 'logs') {
      return this._log.slice().reverse();
    }
    throw new Error(`Unknown: ${method} ${path}`);
  }

  async _refreshDeviceCache() {
    try {
      this._addLog('info', 'Refreshing device cache…');
      const api     = await this._getApi();
      const devices = await api.devices.getDevices();
      const count   = devices ? Object.keys(devices).length : 0;
      this._addLog('info', `getDevices() returned ${count} device(s)`);
      const zones   = await api.zones.getZones().catch(() => ({}));
      this._cachedDevices = Object.values(devices || {}).map(d => ({
        id:              d.id,
        name:            d.name,
        zone:            (zones[d.zone] && zones[d.zone].name) || d.zone || '',
        capabilities:    d.capabilities     || [],
        capabilitiesObj: d.capabilitiesObj  || {},
        class:           d.class,
        driverUri:       d.driverUri || '',
        available:       d.available,
      }));
      this.homey.settings.set('_deviceCache', JSON.stringify(this._cachedDevices));
      this._addLog('info', `Device cache updated: ${this._cachedDevices.length} device(s)`);
    } catch (e) {
      this._api = null; // reset so next call retries
      this._addLog('error', '_refreshDeviceCache: ' + e.message);
    }
  }


  //  Hold-status helpers (let the UI show a live countdown)

  _readHoldStatus() {
    try { return JSON.parse(this.homey.settings.get('_holdStatus') || '{}'); } catch { return {}; }
  }
  _readOverrides()  { try { return JSON.parse(this.homey.settings.get('_overrides') || '{}'); } catch(e) { return {}; } }

  _setHoldStatus(groupId, endsAt) {
    const s = this._readHoldStatus();
    s[groupId] = endsAt;
    try { this.homey.settings.set('_holdStatus', JSON.stringify(s)); } catch (e) {}
  }

  _clearHoldStatus(groupId) {
    const s = this._readHoldStatus();
    if (!(groupId in s)) return;
    delete s[groupId];
    try { this.homey.settings.set('_holdStatus', JSON.stringify(s)); } catch (e) {}
  }

  //  Test request handler

  async _runTestRequest() {
    let req;
    try {
      const raw = this.homey.settings.get('_testRequest');
      if (!raw) return;
      req = JSON.parse(raw);
    } catch (e) { return; }

    this._addLog('info', `Test run: "${req.name}" (${(req.actions||[]).length} actions)`);

    if (req.blink) {
      await this._runBlinkTest(req.actions || [], req.ts, req.name);
      return;
    }

    let results;
    try {
      results = await this._runActions(req.actions || [], `TEST:"${req.name}"`);
    } catch (e) {
      results = [{ action: 'error', ok: false, error: e.message }];
    }
    // Annotate with deviceId for display
    const annotated = results.map((r, i) => ({
      ...r,
      deviceId: req.actions && req.actions[i] && req.actions[i].deviceId
    }));
    this.homey.settings.set('_testResult', JSON.stringify({ reqTs: req.ts, ok: true, results: annotated }));
  }

  async _runBlinkTest(actions, reqTs, name) {
    const wait = ms => new Promise(r => this.homey.setTimeout(r, ms));
    let devices;
    try {
      const api = await this._getApi();
      devices = await api.devices.getDevices();
    } catch (e) {
      this._addLog('warn', 'blinkTest: getDevices failed: ' + e.message);
      this.homey.settings.set('_testResult', JSON.stringify({ reqTs, ok: false, error: e.message }));
      return;
    }

    // Collect unique device IDs from test actions
    const deviceIds = [...new Set(actions.filter(a => a.deviceId).map(a => a.deviceId))];

    // Snapshot current state (onoff + dim) before we touch anything
    const snapshots = {};
    for (const id of deviceIds) {
      const d = devices[id];
      if (!d) continue;
      snapshots[id] = {
        onoff: d.capabilitiesObj?.onoff?.value ?? false,
        dim:   d.capabilitiesObj?.dim  ?.value ?? null
      };
    }

    this._addLog('info', `Blink test "${name}": ${deviceIds.length} light(s), 5 blinks`);

    try {
      // Blink 5 times — ON 400 ms, OFF 400 ms
      for (let i = 0; i < 5; i++) {
        await Promise.all(deviceIds.map(id =>
          devices[id] ? devices[id].setCapabilityValue('onoff', true).catch(() => {}) : Promise.resolve()
        ));
        await wait(400);
        await Promise.all(deviceIds.map(id =>
          devices[id] ? devices[id].setCapabilityValue('onoff', false).catch(() => {}) : Promise.resolve()
        ));
        await wait(400);
      }

      // Restore original state
      await Promise.all(deviceIds.map(async id => {
        const d    = devices[id];
        const snap = snapshots[id];
        if (!d || !snap) return;
        if (snap.onoff) {
          await d.setCapabilityValue('onoff', true).catch(() => {});
          if (snap.dim !== null) await d.setCapabilityValue('dim', snap.dim).catch(() => {});
        } else {
          await d.setCapabilityValue('onoff', false).catch(() => {});
        }
      }));
    } catch (e) {
      this._addLog('error', `blinkTest: ${e.message}`);
    }

    this.homey.settings.set('_testResult', JSON.stringify({ reqTs, ok: true, results: [{ action: 'blink_test', ok: true }] }));
  }

  async _runFlowTriggersRequest() {
    let req;
    try {
      const raw = this.homey.settings.get('_flowTriggersReq');
      if (!raw) return;
      req = JSON.parse(raw);
    } catch (e) { return; }

    const done = (data) =>
      this.homey.settings.set('_flowTriggersResult', JSON.stringify({ reqTs: req.ts, ...data }));

    try {
      const api = await this._getApi();
      const allCards = await api.flow.getFlowCardTriggers();
      const devices  = await api.devices.getDevices();
      const device   = devices[req.deviceId];
      if (!device) return done({ error: 'Device not found', cards: [] });

      const driverUri = device.driverUri || device.ownerUri || '';
      const driverId  = String(device.driverId || '');
      // Extract app bundle ID: "homey:app:com.namron:driver_id" → "com.namron"
      const appId = driverUri ? driverUri.replace('homey:app:', '').split(':')[0] : '';

      const cards = Object.values(allCards || {}).filter(c => {
        const u = c.uri || c.ownerUri || '';

        // 1. Device-instance cards
        if (u === `homey:device:${req.deviceId}` || u.includes(req.deviceId)) return true;

        // 2. Driver-level cards (exact or prefix match on driverUri, or contains driverId)
        if (driverUri && (u === driverUri || u.startsWith(driverUri))) return true;
        if (driverId  && u.includes(driverId)) return true;

        // 3. App-level cards (e.g. "Group 1 on button is pressed") that have a device arg
        //    Include any card from the same app that accepts a device argument
        if (appId && appId.length > 3 && u.includes(appId)) {
          const deviceArg = (c.args || []).find(a => a.type === 'device');
          if (deviceArg) return true;
        }

        return false;
      });
      this._addLog('info', `flow-triggers: ${cards.length} cards for "${device.name}"`);

      // For each card, enrich dropdown args with their selectable values
      const enrichedCards = [];
      for (const c of cards) {
        const title = (typeof c.title === 'object' ? (c.title.en || c.title.no) : c.title) || c.id;
        const uri   = c.uri || c.ownerUri || '';
        const enrichedArgs = [];
        for (const arg of (c.args || [])) {
          if (arg.type === 'dropdown') {
            // Some apps embed values directly on the arg
            if (arg.values && arg.values.length) {
              enrichedArgs.push({ name: arg.name, type: 'dropdown', values: arg.values.map(v => ({
                id: v.id, title: typeof v.title === 'object' ? (v.title.en || v.title.no) : v.title
              }))});
              continue;
            }
            // Try fetching from Homey API
            try {
              const vals = await api.flow.getFlowCardTriggerArgumentValues({ uri, id: c.id, name: arg.name, args: {} });
              const arr  = Array.isArray(vals) ? vals : Object.values(vals || {});
              enrichedArgs.push({ name: arg.name, type: 'dropdown', values: arr.map(v => ({
                id: String(v.id ?? v), title: typeof v.title === 'object' ? (v.title.en || v.title.no) : (v.title || String(v.id ?? v))
              }))});
            } catch(e) {
              this._addLog('warn', `arg values for ${c.id}.${arg.name}: ${e.message}`);
              enrichedArgs.push({ name: arg.name, type: 'dropdown', values: [] });
            }
          } else {
            enrichedArgs.push({ name: arg.name, type: arg.type });
          }
        }
        enrichedCards.push({ id: c.id, title, uri, args: enrichedArgs });
      }
      done({ cards: enrichedCards });
    } catch (e) {
      this._addLog('error', 'flowTriggersReq: ' + e.message);
      done({ error: e.message, cards: [] });
    }
  }

  async _runFlowSyncRequest() {
    let req;
    try {
      const raw = this.homey.settings.get('_flowSyncReq');
      if (!raw) return;
      req = JSON.parse(raw);
    } catch (e) { return; }

    const done = (data) =>
      this.homey.settings.set('_flowSyncResult', JSON.stringify({ reqTs: req.ts, ...data }));

    try {
      // Use user-provided PAT for flow creation if available (it has homey.flow write scope)
      let api;
      const pat = this.homey.settings.get('_homeyPAT');
      if (pat) {
        const localUrl = await this.homey.api.getLocalUrl();
        api = await HomeyAPI.createLocalAPI({ address: localUrl, token: pat });
        this._addLog('info', 'Using Personal Access Token for flow creation');
      } else {
        api = await this._getApi();
      }

      for (const id of (req.existingFlowIds || [])) {
        await api.flow.deleteFlow({ id }).catch(e =>
          this._addLog('warn', `Could not delete flow ${id}: ${e.message}`)
        );
      }
      const createdIds = [];
      for (const m of (req.mappings || [])) {
        if (!m.groupId) continue;
        try {
          const actionId = m._actionType === 'cancel_override'
            ? 'homey:app:no.easy.automation:cancel_override'
            : m._actionType === 'override' || m._isOverride
              ? 'homey:app:no.easy.automation:override_group'
              : 'homey:app:no.easy.automation:run_group';
          // m.triggerId is already the fully-qualified combined ID e.g. "homey:device:{id}:sr_on_button_mode_g4"
          const flow = await api.flow.createFlow({ flow: {
            name:    `[Easy Auto] ${m.groupName} ← ${m.triggerTitle}`,
            enabled: true,
            trigger: { id: m.triggerId, args: m.triggerArgs || {} },
            conditions: [],
            actions: [{ id: actionId,
                        args: { group: { id: m.groupId, name: m.groupName } } }]
          }});
          createdIds.push(flow.id);
          this._addLog('info', `Created flow "${flow.name}" (${flow.id})`);
        } catch (fe) {
          this._addLog('warn', `Could not create flow for "${m.groupName}": ${fe.message}`);
        }
      }
      if (createdIds.length > 0) {
        done({ ok: true, flowIds: createdIds });
      } else {
        done({ ok: false, error: pat ? 'Flow creation failed — check your PAT has Flows permission' : 'Missing Scopes — add a Personal Access Token in app settings' });
      }
    } catch (e) {
      this._addLog('error', 'flowSyncReq: ' + e.message);
      done({ ok: false, error: e.message });
    }
  }

  async _runPreviewRequest() {
    const raw = this.homey.settings.get('_previewReq');
    if (!raw) return;
    const { deviceId, value, capability } = typeof raw === 'string' ? JSON.parse(raw) : raw;
    this._addLog('info', `[preview] ${deviceId} → ${Math.round(value * 100)}% (${capability || 'dim'})`);
    const api = await this._getApi();
    const devices = await api.devices.getDevices();
    const device = devices[deviceId];
    if (!device) { this._addLog('warn', `[preview] device not found: ${deviceId}`); return; }
    const hasCap = cap => device.capabilities && device.capabilities.includes(cap);
    if (capability === 'ct') {
      if (hasCap('light_temperature')) await device.setCapabilityValue('light_temperature', value).catch(e => this._addLog('warn', `[preview] ct: ${e.message}`));
    } else {
      if (value <= 0) {
        if (hasCap('onoff')) await device.setCapabilityValue('onoff', false).catch(e => this._addLog('warn', `[preview] onoff=false: ${e.message}`));
      } else {
        if (hasCap('onoff')) await device.setCapabilityValue('onoff', true).catch(e => this._addLog('warn', `[preview] onoff=true: ${e.message}`));
        if (hasCap('dim')) await device.setCapabilityValue('dim', value).catch(e => this._addLog('warn', `[preview] dim=${value}: ${e.message}`));
      }
    }
  }

  async _runFlowCheckRequest() {
    let req;
    try {
      const raw = this.homey.settings.get('_flowCheckReq');
      if (!raw) return;
      req = JSON.parse(raw);
    } catch (e) { return; }

    const done = (data) =>
      this.homey.settings.set('_flowCheckResult', JSON.stringify({ reqTs: req.ts, ...data }));

    try {
      const api = await this._getApi();
      const allFlows = await api.flow.getFlows();
      const flows = {};
      for (const id of (req.flowIds || [])) {
        const f = allFlows[id];
        flows[id] = f ? { name: f.name, enabled: f.enabled } : null;
      }
      done({ ok: true, flows });
    } catch (e) {
      this._addLog('error', 'flowCheckReq: ' + e.message);
      done({ ok: false, error: e.message });
    }
  }

  async _runFlowActionCardsRequest() {
    let req;
    try {
      const raw = this.homey.settings.get('_flowActionCardsReq');
      if (!raw) return;
      req = JSON.parse(raw);
    } catch (e) { return; }

    const done = (data) =>
      this.homey.settings.set('_flowActionCardsResult', JSON.stringify({ reqTs: req.ts, ...data }));

    try {
      const api = await this._getApi();
      const allCards = await api.flow.getFlowCardActions();
      const devices  = await api.devices.getDevices();
      const device   = devices[req.deviceId];
      if (!device) return done({ error: 'Device not found', cards: [] });

      const driverUri = device.driverUri || device.ownerUri || '';
      const driverId  = String(device.driverId || '');
      const appId = driverUri ? driverUri.replace('homey:app:', '').split(':')[0] : '';

      const cards = Object.values(allCards || {}).filter(c => {
        const u = c.uri || c.ownerUri || '';
        if (u === `homey:device:${req.deviceId}` || u.includes(req.deviceId)) return true;
        if (driverUri && (u === driverUri || u.startsWith(driverUri))) return true;
        if (driverId  && u.includes(driverId)) return true;
        if (appId && appId.length > 3 && u.includes(appId)) {
          const deviceArg = (c.args || []).find(a => a.type === 'device');
          if (deviceArg) return true;
        }
        return false;
      });

      const result = cards.map(c => ({
        id:    c.id,
        title: typeof c.title === 'object' ? (c.title.en || c.title.no || c.id) : (c.title || c.id),
        uri:   c.uri || c.ownerUri || '',
        args:  (c.args || []).map(a => ({ name: a.name, type: a.type }))
      }));

      this._addLog('info', `flow-action-cards: ${result.length} for "${device.name}": ${result.map(c=>c.id).join(', ')}`);
      done({ cards: result });
    } catch (e) {
      this._addLog('error', 'flowActionCardsReq: ' + e.message);
      done({ error: e.message, cards: [] });
    }
  }

  //  Automation storage

  _getAutomations() {
    try {
      const raw = this.homey.settings.get('automations');
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      this.error('Failed to parse automations:', e.message);
      return [];
    }
  }

  _getGroups() {
    const byId = {};
    const order = [];
    for (const a of this._getAutomations()) {
      const gid = a._groupId || a.id;
      if (!byId[gid]) {
        byId[gid] = { id: gid, name: a._groupName || a.name || gid, type: a._templateType || 'custom' };
        order.push(gid);
      }
    }
    return order.map(id => byId[id]);
  }


  //  Listener management 

  async _attachAllListeners() {
    const automations = this._getAutomations();
    if (!automations.length) return;

    // Store on this so Node.js does NOT garbage-collect the API instance.
    // If it gets GC'd the WebSocket closes and capability listeners stop firing.
    this._listenerApi = await HomeyAPI.createAppAPI({ homey: this.homey });
    const devices     = await this._listenerApi.devices.getDevices();
    this._liveDevices = devices; // cache for use in _runActions

    for (const automation of automations) {
      if (!automation.enabled) continue;
      await this._attachTrigger(automation, devices).catch(e =>
        this._addLog('error', `attach "${automation.name}": ${e.message}`)
      );
    }

    // After re-attaching, restore hold timers for any OFF automations whose
    // sensor is already inactive (alarm_motion=false / alarm_contact=false).
    // This handles the case where settings were saved while a hold timer was running.
    await this._restoreHoldTimers(devices).catch(e =>
      this._addLog('error', 'restoreHoldTimers: ' + e.message)
    );

    // Attach override switch listeners for groups that have a button override configured
    await this._attachOverrideSwitchListeners(devices).catch(e =>
      this._addLog('error', 'attachOverrideSwitchListeners: ' + e.message)
    );

    this._scheduleTimeChecks();
    this._scheduleReconnect();
  }

  async _restoreHoldTimers(devices) {
    const automations = this._getAutomations();
    for (const automation of automations) {
      if (!automation.enabled) continue;
      const t = automation.trigger;
      if (!t) continue;

      const isOffTrigger = t.type === 'motion_stop' || t.type === 'door_close';
      if (!isOffTrigger) continue;

      const holdMs = (automation._holdMinutes || 0) * 60 * 1000;
      if (holdMs <= 0) continue;

      const device = devices[t.deviceId];
      if (!device) continue;

      const cap = this._triggerCapability(t);
      if (!cap) continue;

      // Read current capability value
      const capObj = device.capabilitiesObj && device.capabilitiesObj[cap];
      const currentValue = capObj && capObj.value;

      // If sensor is already inactive (no motion / door closed), re-queue the hold timer
      if (!this._triggerMatches(t, currentValue)) continue; // still active, no need
      // currentValue matches the off trigger (false for motion_stop/door_close)
      const key = t.deviceId + ':' + automation.id;
      if (this._holdTimers.has(key)) continue; // already running

      this._addLog('info', `Restoring hold timer for "${automation.name}" (sensor already inactive)`);
      const endsAt = Date.now() + holdMs;
      this._setHoldStatus(automation._groupId || automation.id, endsAt);
      const timer = this.homey.setTimeout(async () => {
        this._holdTimers.delete(key);
        this._clearHoldStatus(automation._groupId || automation.id);
        this._addLog('trigger', `"${automation.name}" hold timer expired (restored)`);
        await this._evaluateAndRun(automation).catch(e =>
          this._addLog('error', `run "${automation.name}": ${e.message}`)
        );
      }, holdMs);
      this._holdTimers.set(key, timer);
    }
  }

  async _attachTrigger(automation, devices) {
    const t = automation.trigger;
    if (!t || t.type === 'time' || t.type === 'manual') return;

    // homey_flow switches: listen directly to device events, match against _switchMappings
    if (t.type === 'homey_flow') {
      const device = devices[t.deviceId];
      if (!device) {
        this._addLog('warn', `Switch device not found: ${t.deviceId} (${automation.name})`);
        return;
      }
      const mappings = automation._switchMappings || [];
      if (!mappings.length) return;

      // Helper: run the group for a given mapping
      const runMapping = async m => {
        if (m._isOverride) {
          this._addLog('trigger', `Override switch "${device.name}" → override group "${m.groupId}"`);
          await this._doOverride(m.groupId, m._overrideBright != null ? m._overrideBright : 1, m._overrideDur || 30).catch(e =>
            this._addLog('error', `doOverride: ${e.message}`)
          );
          return;
        }
        this._addLog('trigger', `Switch "${device.name}" → group "${m.groupName}"`);
        const offTypes = new Set(['motion_stop', 'door_close', 'switch_off']);
        const allAutos = this._getAutomations().filter(
          a => a._groupId === m.groupId && a.enabled !== false
        );
        const target = allAutos.find(a => !a.trigger || !offTypes.has(a.trigger.type)) || allAutos[0];
        if (target) {
          await this._runActions(target.actions || [], target.name).catch(e =>
            this._addLog('error', `run "${m.groupName}": ${e.message}`)
          );
        }
      };

      // Log device capabilities for diagnostics
      const caps = Object.keys(device.capabilitiesObj || {});
      this._addLog('info', `[switch] ${device.name} caps: ${caps.join(', ') || 'none'}`);

      // Explicitly connect to the device namespace so socket events are received
      try { await device.connect(); } catch (e) { /* ignore */ }

      // Listen for raw capability events (fires when any capability value changes)
      device.on('capability', data => {
        const { capabilityId, value } = data || {};
        this._addLog('info', `[switch cap] ${device.name}.${capabilityId} = ${JSON.stringify(value)}`);
        for (const m of mappings) {
          if (!m.groupId) continue;
          if (this._switchMappingMatches(m.triggerArgs || {}, data)) {
            runMapping(m).catch(() => {});
            break;
          }
        }
      });

      // Listen for all known socket event names (some devices fire these instead of capabilities)
      const knownEvents = ['key_action', 'action', 'button', 'scene', 'remote_key_action',
                           'shortPress', 'longPress', 'trigger', 'pressed', 'button_action'];
      knownEvents.forEach(evName => {
        device.on(evName, async data => {
          this._addLog('info', `[switch evt] ${device.name} → "${evName}" ${JSON.stringify(data)}`);
          for (const m of mappings) {
            if (!m.groupId) continue;
            if (this._switchMappingMatches(m.triggerArgs || {}, data)) {
              await runMapping(m);
              break;
            }
          }
        });
      });

      // Try subscribing to FlowCardTrigger items — if Homey emits events when a trigger fires,
      // we can catch them here without needing actual Homey Flows to exist.
      const seenTriggers = new Set();
      for (const m of mappings) {
        if (!m.triggerId || !m.triggerUri) continue;
        const fullId = `${m.triggerUri}:${m.triggerId}`;
        if (seenTriggers.has(fullId)) continue;
        seenTriggers.add(fullId);
        try {
          const card = await this._listenerApi.flow.getFlowCardTrigger({ id: fullId });
          if (!card) continue;
          await card.connect();
          // Listen for all possible trigger-fired event names
          ['trigger', 'run', 'fire', 'triggered'].forEach(evName => {
            card.on(evName, data => {
              this._addLog('info', `[FCT ${evName}] ${fullId}: ${JSON.stringify(data)}`);
              for (const mm of mappings) {
                if (!mm.groupId) continue;
                if (`${mm.triggerUri}:${mm.triggerId}` === fullId &&
                    this._switchMappingMatches(mm.triggerArgs || {}, data || {})) {
                  runMapping(mm).catch(() => {});
                  break;
                }
              }
            });
          });
          this._capInstances.push(card); // prevent GC; destroy() on cleanup
          this._addLog('info', `[switch] Subscribed to FlowCardTrigger: ${fullId}`);
        } catch (e) {
          this._addLog('info', `[switch] FlowCardTrigger ${fullId}: ${e.message}`);
        }
      }

      this._addLog('info', `Switch listener attached: "${automation.name}" → ${device.name}`);
      return;
    }

    const device = devices[t.deviceId];
    if (!device) {
      this._addLog('warn', `Device not found: ${t.deviceId} (${automation.name})`);
      return;
    }

    const cap = this._triggerCapability(t);
    if (!cap) return;

    const isOnTrigger  = t.type === 'motion_start' || t.type === 'door_open';
    const isOffTrigger = t.type === 'motion_stop'  || t.type === 'door_close';
    const holdMs       = isOffTrigger ? (automation._holdMinutes || 0) * 60 * 1000 : 0;

    const handler = async value => {
      if (!this._triggerMatches(t, value)) return;

      // Check if this automation group has an active override
      const gid = automation._groupId || automation.id;
      const overrides = this._readOverrides();
      if (overrides[gid] && Date.now() < overrides[gid]) {
        this._addLog('skipped', `"${automation.name}" — override active, skipping trigger`);
        return;
      }

      this._addLog('trigger', `"${automation.name}" triggered by ${device.name}`);

      if (isOnTrigger) {
        const prefix = t.deviceId + ':';
        const toCancel = [...this._holdTimers.keys()].filter(k => k.startsWith(prefix));
        toCancel.forEach(key => {
          this.homey.clearTimeout(this._holdTimers.get(key));
          this._holdTimers.delete(key);
          this._addLog('info', `Hold timer cancelled (motion restarted)`);
        });
        // Clear any countdown status for automations on this sensor
        if (toCancel.length) {
          const allIds = [...new Set(this._getAutomations()
            .filter(a => a.trigger && a.trigger.deviceId === t.deviceId)
            .map(a => a._groupId || a.id))];
          allIds.forEach(id => this._clearHoldStatus(id));
        }

        // Start / restart safety timer for this group
        const gid = automation._groupId || automation.id;
        const safetyKey = t.deviceId + ':safety:' + gid;
        if (this._safetyTimers.has(safetyKey)) {
          this.homey.clearTimeout(this._safetyTimers.get(safetyKey));
        }
        // Find the OFF automation for this group to get its hold time
        const offTypes = new Set(['motion_stop', 'door_close', 'switch_off']);
        const offAuto = this._getAutomations().find(a =>
          (a._groupId || a.id) === gid && a.trigger && offTypes.has(a.trigger.type)
        );
        const offHoldMs = offAuto ? (offAuto._holdMinutes || 0) * 60 * 1000 : 0;
        const safetyMs  = offHoldMs + 30 * 60 * 1000; // hold time + 30 min buffer
        const safetyTimer = this.homey.setTimeout(async () => {
          this._safetyTimers.delete(safetyKey);
          this._addLog('warn', `Safety timer fired for "${automation.name}" — forcing lights off`);
          if (offAuto) {
            await this._evaluateAndRun(offAuto).catch(e =>
              this._addLog('error', `safety run "${offAuto.name}": ${e.message}`)
            );
          }
        }, safetyMs);
        this._safetyTimers.set(safetyKey, safetyTimer);
        this._addLog('info', `Safety timer set for "${automation.name}" (${Math.round(safetyMs/60000)} min)`);
      }

      if (holdMs > 0) {
        const key = t.deviceId + ':' + automation.id;
        if (this._holdTimers.has(key)) this.homey.clearTimeout(this._holdTimers.get(key));
        const endsAt = Date.now() + holdMs;
        this._setHoldStatus(automation._groupId || automation.id, endsAt);
        const timer = this.homey.setTimeout(async () => {
          this._holdTimers.delete(key);
          this._clearHoldStatus(automation._groupId || automation.id);
          this._addLog('trigger', `"${automation.name}" hold timer expired`);
          await this._evaluateAndRun(automation).catch(e =>
            this._addLog('error', `run "${automation.name}": ${e.message}`)
          );
        }, holdMs);
        this._holdTimers.set(key, timer);
        this._addLog('info', `"${automation.name}" will run in ${automation._holdMinutes} min`);
      } else {
        await this._evaluateAndRun(automation).catch(e =>
          this._addLog('error', `run "${automation.name}": ${e.message}`)
        );
      }
    };

    // makeCapabilityInstance creates a live subscription — addListener alone never fires
    const instance = await device.makeCapabilityInstance(cap, handler);
    this._capInstances.push(instance);
    this._addLog('info', `Listening: "${automation.name}" → ${device.name}.${cap}`);

    // For remote_event triggers: also log ALL Socket.IO events so we can discover the real event name
    if (t.type === 'remote_event') {
      const knownEvents = ['key_action', 'action', 'button', 'scene', 'remote_key_action', 'shortPress', 'longPress'];
      knownEvents.forEach(evName => {
        device.on(evName, data => {
          this._addLog('info', `[remote_event] ${device.name} → event="${evName}" data=${JSON.stringify(data)}`);
          if (this._triggerMatches(t, data)) {
            this._evaluateAndRun(automation).catch(e =>
              this._addLog('error', `run "${automation.name}": ${e.message}`)
            );
          }
        });
      });
    }
  }

  _switchMappingMatches(triggerArgs, eventData) {
    if (!eventData || typeof eventData !== 'object') return false;
    const keys = Object.keys(triggerArgs);
    if (!keys.length) return false;
    return keys.every(k => {
      const ev = eventData[k];
      const tr = triggerArgs[k];
      return ev === tr || String(ev) === String(tr);
    });
  }

  async _attachOverrideSwitchListeners(devices) {
    const seen = new Set();
    for (const automation of this._getAutomations()) {
      if (!automation.enabled) continue;
      if (!automation._overrideSwitch || !automation._overrideSwitch.deviceId) continue;

      const gid = automation._groupId || automation.id;
      if (seen.has(gid)) continue;
      seen.add(gid);

      const ov     = automation._overrideSwitch;
      const device = devices[ov.deviceId];
      if (!device) {
        this._addLog('warn', `Override switch not found: ${ov.deviceId}`);
        continue;
      }

      const caps = device.capabilities || [];

      // Normalise: support new { onMapping, offMapping } format + legacy triggerMappings[]
      const slotMappings = [];
      if (ov.onMapping)  slotMappings.push({ ...ov.onMapping,  _role: 'on'  });
      if (ov.offMapping) slotMappings.push({ ...ov.offMapping, _role: 'off' });
      if (!slotMappings.length && ov.triggerMappings && ov.triggerMappings.length) {
        // backward compat: all legacy mappings activate override
        ov.triggerMappings.forEach(m => slotMappings.push({ ...m, _role: 'on' }));
      }

      if (slotMappings.length) {
        const capMappings  = slotMappings.filter(m => m.triggerType !== 'flow_card');
        const flowMappings = slotMappings.filter(m => m.triggerType === 'flow_card');

        // ── cap/socket fallback listeners (for non-Z-wave devices) ─────────
        for (const m of capMappings) {
          const capL = m.triggerType === 'button_key'  ? m.cap
                     : m.triggerType === 'button_press' ? 'button'
                     : m.triggerType === 'socket_event' ? null
                     : 'onoff';
          const handler = async value => {
            if (value !== true) return;
            this._addLog('trigger', `Override switch "${device.name}" → group "${gid}" (${capL}, ${m._role})`);
            if (m._role === 'off') await this._cancelOverride(gid);
            else await this._doOverride(gid, ov.brightness, ov.durationMinutes).catch(e =>
              this._addLog('error', `doOverride: ${e.message}`)
            );
          };
          if (capL) {
            try {
              const instance = await device.makeCapabilityInstance(capL, handler);
              this._capInstances.push(instance);
              this._addLog('info', `Override switch attached: "${device.name}" → group "${gid}" (${capL})`);
            } catch (e) {
              this._addLog('warn', `Override switch cap "${capL}": ${e.message}`);
            }
          }
          if (m.triggerType === 'socket_event') {
            try { await device.connect(); } catch (e) { /* ignore */ }
            const evName = m.eventName;
            device.on(evName, async data => {
              if (!this._switchMappingMatches(m.eventData || {}, data || {})) return;
              this._addLog('trigger', `Override switch "${device.name}" → "${evName}" → group "${gid}" (${m._role})`);
              if (m._role === 'off') await this._cancelOverride(gid);
              else await this._doOverride(gid, ov.brightness, ov.durationMinutes).catch(() => {});
            });
          }
        }

        // ── flow_card: real Homey Flows are created at save time; nothing to attach here ──
        if (flowMappings.length) {
          this._addLog('info', `Override switch "${device.name}" → group "${gid}" (${flowMappings.length} flow card(s) via Homey Flows)`);
        }
      } else {
        // Legacy: any press on button or onoff
        const cap = caps.includes('button') ? 'button'
                  : caps.includes('onoff')  ? 'onoff'
                  : null;
        if (!cap) {
          this._addLog('warn', `Override switch "${device.name}" has no button/onoff capability`);
          continue;
        }
        const handler = async value => {
          if (value !== true) return;
          this._addLog('trigger', `Override switch "${device.name}" → group "${gid}"`);
          await this._doOverride(gid, ov.brightness, ov.durationMinutes).catch(e =>
            this._addLog('error', `doOverride: ${e.message}`)
          );
        };

        try {
          const instance = await device.makeCapabilityInstance(cap, handler);
          this._capInstances.push(instance);
          this._addLog('info', `Override switch attached: "${device.name}" → group "${gid}" (${cap})`);
        } catch (e) {
          this._addLog('error', `Override switch attach "${device.name}": ${e.message}`);
        }
      }
    }
  }

  async _doOverride(gid, brightness, durationMinutes) {
    const b        = brightness != null ? brightness : 1;
    const durationMs = (durationMinutes || 30) * 60 * 1000;

    // Collect light device IDs from all ON automations in this group
    const lightIds = [];
    for (const a of this._getAutomations()) {
      if (!a.enabled) continue;
      if ((a._groupId || a.id) !== gid) continue;
      const onTypes = new Set(['motion_start', 'door_open', 'manual']);
      if (!a.trigger || !onTypes.has(a.trigger.type)) continue;
      for (const ac of (a.actions || [])) {
        if (ac.type === 'turn_on' && ac.deviceId && !lightIds.includes(ac.deviceId))
          lightIds.push(ac.deviceId);
      }
    }

    // Set lights to override brightness
    try {
      const api = await this._getApi();
      const allDevices = await api.devices.getDevices();
      await Promise.all(lightIds.map(async id => {
        const d = allDevices[id];
        if (!d) return;
        if (d.capabilities && d.capabilities.includes('onoff'))
          await d.setCapabilityValue('onoff', true).catch(() => {});
        if (d.capabilities && d.capabilities.includes('dim'))
          await d.setCapabilityValue('dim', b).catch(() => {});
      }));
      this._addLog('action', `Override: ${lightIds.length} light(s) → ${Math.round(b * 100)}% for ${durationMinutes}min`);
    } catch (e) {
      this._addLog('error', `Override set lights: ${e.message}`);
      this._api = null;
    }

    // Store override timestamp so motion triggers are skipped during the period
    const endsAt    = Date.now() + durationMs;
    const overrides = this._readOverrides();
    overrides[gid]  = endsAt;
    try { this.homey.settings.set('_overrides', JSON.stringify(overrides)); } catch (e) {}

    // Cancel any previous override timer and set a new one
    const timerKey = 'override:' + gid;
    if (this._overrideTimers.has(timerKey))
      this.homey.clearTimeout(this._overrideTimers.get(timerKey));
    const timer = this.homey.setTimeout(() => {
      this._overrideTimers.delete(timerKey);
      const ov2 = this._readOverrides();
      delete ov2[gid];
      try { this.homey.settings.set('_overrides', JSON.stringify(ov2)); } catch (e) {}
      this._addLog('info', `Override expired for group "${gid}"`);
    }, durationMs);
    this._overrideTimers.set(timerKey, timer);
    this._addLog('info', `Override active for ${durationMinutes}min, group "${gid}"`);
  }

  _cancelOverride(gid) {
    const timerKey = 'override:' + gid;
    if (this._overrideTimers.has(timerKey))
      this.homey.clearTimeout(this._overrideTimers.get(timerKey));
    this._overrideTimers.delete(timerKey);
    const overrides = this._readOverrides();
    delete overrides[gid];
    try { this.homey.settings.set('_overrides', JSON.stringify(overrides)); } catch (e) {}
    this._addLog('info', `Override cancelled for group "${gid}"`);
  }

  async _runOvLearnRequest() {
    let req;
    try {
      const raw = this.homey.settings.get('_ovLearnReq');
      if (!raw) return;
      req = JSON.parse(raw);
    } catch (e) { return; }
    const { deviceId, ts } = req;

    const done = result =>
      this.homey.settings.set('_ovLearnResult', JSON.stringify({ reqTs: ts, ...result }));

    try {
      const api = await this._getApi();
      const devices = await api.devices.getDevices();
      const device  = devices[deviceId];
      if (!device) { done({ error: 'Device not found' }); return; }

      try { await device.connect(); } catch (e) { /* ignore */ }

      let fired = false;
      const listeners = {};
      let timerRef;

      const fire = result => {
        if (fired) return;
        fired = true;
        this.homey.clearTimeout(timerRef);
        Object.entries(listeners).forEach(([evName, h]) => {
          try { device.removeListener(evName, h); } catch (e) {}
        });
        done(result);
      };

      const knownEvents = ['key_action', 'action', 'button', 'scene', 'remote_key_action',
                           'shortPress', 'longPress', 'trigger', 'pressed', 'button_action'];
      knownEvents.forEach(evName => {
        const h = data => {
          this._addLog('info', `[learn] ${device.name} → "${evName}" ${JSON.stringify(data)}`);
          fire({ eventType: 'socket', eventName: evName, data: data || {} });
        };
        device.on(evName, h);
        listeners[evName] = h;
      });

      const capH = eventData => {
        const { capabilityId, value } = eventData || {};
        if (value !== true) return;
        this._addLog('info', `[learn] ${device.name}.${capabilityId} = ${value}`);
        fire({ eventType: 'capability', capabilityId, value });
      };
      device.on('capability', capH);
      listeners['capability'] = capH;

      timerRef = this.homey.setTimeout(() => fire({ error: 'timeout' }), 15000);
    } catch (e) {
      done({ error: e.message });
    }
  }

  _triggerCapability(t) {
    switch (t.type) {
      case 'motion_start':
      case 'motion_stop':       return 'alarm_motion';
      case 'door_open':
      case 'door_close':        return 'alarm_contact';
      case 'switch_on':
      case 'switch_off':        return 'onoff';
      case 'button_press':      return 'button';
      case 'button_key':        return t.capability;
      case 'remote_event':      return 'measure_battery'; // connect via battery to open WebSocket
      case 'device_capability': return t.capability;
      default:                  return null;
    }
  }

  _triggerMatches(t, value) {
    switch (t.type) {
      case 'motion_start':      return value === true;
      case 'motion_stop':       return value === false;
      case 'door_open':         return value === true;
      case 'door_close':        return value === false;
      case 'switch_on':         return value === true;
      case 'switch_off':        return value === false;
      case 'button_press':      return value === true;
      case 'button_key':        return value === true;
      case 'remote_event':      return true; // matched in the event listener itself
      case 'device_capability': return String(value) === String(t.value);
      default:                  return false;
    }
  }

  _scheduleTimeChecks() {
    if (this._minuteTimer) this.homey.clearInterval(this._minuteTimer);
    this._minuteTimer = this.homey.setInterval(
      () => this._checkTimeTriggers().catch(e =>
        this._addLog('error', 'checkTimeTriggers: ' + e.message)
      ),
      60 * 1000
    );
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) this.homey.clearInterval(this._reconnectTimer);
    this._reconnectTimer = this.homey.setInterval(async () => {
      if (!this._listenerApi) return;
      try {
        // Lightweight ping — if the WebSocket dropped this will throw
        await this._listenerApi.devices.getDevices();
      } catch (e) {
        this._addLog('warn', 'Listener WebSocket dropped — reconnecting subscriptions...');
        this._detachAllListeners();
        await this._attachAllListeners().catch(err =>
          this._addLog('error', 'Reconnect failed: ' + err.message)
        );
      }
    }, 10 * 60 * 1000); // health-check every 10 minutes
  }

  _localHHMM() {
    const tz   = this.homey.clock.getTimezone();
    const now  = new Date();
    const fmt  = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
    return fmt.format(now).replace('\u202f','').replace(' ',''); // "HH:MM"
  }

  _localDow() {
    const tz  = this.homey.clock.getTimezone();
    const now = new Date();
    // Get day-of-week in local timezone (0=Sun)
    const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(now);
    return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(day);
  }

  async _checkTimeTriggers() {
    const hhmm = this._localHHMM();
    const dow  = this._localDow();
    for (const automation of this._getAutomations()) {
      if (!automation.enabled) continue;
      if (!automation.trigger || automation.trigger.type !== 'time') continue;
      if (automation.trigger.time !== hhmm) continue;
      const days = automation.trigger.days;
      if (days && days.length && !days.includes(dow)) continue;
      this._addLog('trigger', `"${automation.name}" triggered by time ${hhmm}`);
      await this._evaluateAndRun(automation).catch(e =>
        this._addLog('error', `time "${automation.name}": ${e.message}`)
      );
    }
  }

  _detachAllListeners() {
    // Destroy all capability subscriptions
    for (const instance of this._capInstances) {
      try { instance.destroy(); } catch (e) {}
    }
    this._capInstances = [];
    this._listenerApi  = null;
    this._liveDevices  = null;

    for (const timer of this._holdTimers.values()) {
      try { this.homey.clearTimeout(timer); } catch (e) {}
    }
    this._holdTimers.clear();

    for (const timer of this._safetyTimers.values()) {
      try { this.homey.clearTimeout(timer); } catch (e) {}
    }
    this._safetyTimers.clear();

    for (const timer of this._overrideTimers.values()) {
      try { this.homey.clearTimeout(timer); } catch (e) {}
    }
    this._overrideTimers.clear();

    try { this.homey.settings.set('_holdStatus', '{}'); } catch (e) {}

    if (this._minuteTimer) {
      this.homey.clearInterval(this._minuteTimer);
      this._minuteTimer = null;
    }
    if (this._reconnectTimer) {
      this.homey.clearInterval(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  //  Conditions 

  async _evaluateAndRun(automation) {
    const ok = await this._checkConditions(automation.conditions || []);
    if (!ok) {
      this._addLog('skipped', `"${automation.name}" conditions not met`);
      return;
    }
    await this._runActions(automation.actions || [], automation.name);

    // Cancel safety timer if this was an OFF automation
    const offTypes = new Set(['motion_stop', 'door_close', 'switch_off']);
    if (automation.trigger && offTypes.has(automation.trigger.type)) {
      const gid      = automation._groupId || automation.id;
      const safetyKey = automation.trigger.deviceId + ':safety:' + gid;
      if (this._safetyTimers.has(safetyKey)) {
        this.homey.clearTimeout(this._safetyTimers.get(safetyKey));
        this._safetyTimers.delete(safetyKey);
      }
    }
  }

  async _checkConditions(conditions) {
    for (const c of conditions) {
      if (!await this._checkCondition(c).catch(() => false)) return false;
    }
    return true;
  }

  async _checkCondition(c) {
    if (c.type === 'time_between') {
      const hhmm = this._localHHMM();
      // Midnight wrap-around: if from > to the range crosses midnight (e.g. 23:55 → 06:00)
      if (c.from > c.to) {
        return hhmm >= c.from || hhmm <= c.to;
      }
      return hhmm >= c.from && hhmm <= c.to;
    }
    if (c.type === 'device_is') {
      try {
        const api = await this._getApi();
        const devices = await api.devices.getDevices();
        const device  = devices[c.deviceId];
        if (!device) return false;
        const capObj = device.capabilitiesObj && device.capabilitiesObj[c.capability];
        const val = capObj && capObj.value;
        return String(val) === String(c.value);
      } catch (e) {
        this._api = null;
        this._addLog('warn', `device_is condition failed: ${e.message}`);
        return false;
      }
    }
    if (c.type === 'lux_below') {
      try {
        const api = await this._getApi();
        const devices = await api.devices.getDevices();
        const device = devices[c.deviceId];
        if (!device) return true;
        const capObj = device.capabilitiesObj && device.capabilitiesObj['measure_luminance'];
        const lux = capObj != null ? capObj.value : null;
        return lux != null ? lux <= c.maxLux : true;
      } catch(e) {
        this._api = null;
        this._addLog('warn', `lux_below condition failed: ${e.message}`);
        return true;
      }
    }
    return true;
  }

  //  Actions 

  async _runActions(actions, name) {
    let devices;
    if (this._liveDevices) {
      devices = this._liveDevices;
    } else {
      try {
        const api = await this._getApi();
        devices = await api.devices.getDevices();
        this._liveDevices = devices;
      } catch (e) {
        this._addLog('warn', 'getDevices failed, using cache: ' + e.message);
        this._api = null; // reset so next call retries
        devices = {};
        this._cachedDevices.forEach(d => { devices[d.id] = d; });
      }
    }

    // Snapshot which devices are already on BEFORE we run any actions.
    // Used by fade_to to skip the "snap to 0" step when lights are already lit,
    // which would otherwise cause a visible blink.
    const initiallyOn = new Set(
      Object.values(devices).filter(d =>
        d.capabilitiesObj && d.capabilitiesObj.onoff && d.capabilitiesObj.onoff.value === true
      ).map(d => d.id)
    );

    const results = [];
    let i = 0;

    while (i < actions.length) {
      const action = actions[i];
      const isFade = action.type === 'fade_to' || action.type === 'fade_off';

      const isBlocking = action.type === 'wait' || action.type === 'run_group' || action.type === 'notify';

      if (isFade || !isBlocking) {
        // Collect all consecutive non-blocking actions and run them in parallel
        let batch = [];
        while (i < actions.length) {
          const a = actions[i];
          const aIsBlocking = a.type === 'wait' || a.type === 'run_group' || a.type === 'notify';
          if (aIsBlocking) break;
          batch.push(a);
          i++;
        }
        // Optimise: if a batch contains both turn_on and set_dim for the same device,
        // drop the turn_on — set_dim > 0 implicitly turns on most dimmers (incl. Plejd),
        // and this saves one extra BLE round-trip per device.
        const dimDevices = new Set(
          batch.filter(a => a.type === 'set_dim' && parseFloat(a.value) > 0).map(a => a.deviceId)
        );
        if (dimDevices.size > 0) {
          batch = batch.filter(a => !(a.type === 'turn_on' && dimDevices.has(a.deviceId)));
        }
        const batchResults = await Promise.all(batch.map(async a => {
          try {
            await this._runAction(a, devices, initiallyOn);
            this._addLog('action', `[${name}] ${a.type} OK`);
            return { action: a.type, deviceId: a.deviceId, ok: true };
          } catch (e) {
            this._addLog('error', `[${name}] ${a.type}: ${e.message}`);
            return { action: a.type, deviceId: a.deviceId, ok: false, error: e.message };
          }
        }));
        results.push(...batchResults);
      } else {
        try {
          await this._runAction(action, devices, initiallyOn);
          results.push({ action: action.type, deviceId: action.deviceId, ok: true });
          this._addLog('action', `[${name}] ${action.type} OK`);
        } catch (e) {
          results.push({ action: action.type, deviceId: action.deviceId, ok: false, error: e.message });
          this._addLog('error', `[${name}] ${action.type}: ${e.message}`);
        }
        i++;
      }
    }
    return results;
  }


  async _runAction(action, devices, initiallyOn = new Set()) {
    const dev = id => {
      const d = devices[id];
      if (!d) throw new Error(`Device not found: ${id}`);
      return d;
    };

    switch (action.type) {
      case 'turn_on':
        return dev(action.deviceId).setCapabilityValue('onoff', true);
      case 'turn_off':
        return dev(action.deviceId).setCapabilityValue('onoff', false);
      case 'set_dim':
        return dev(action.deviceId).setCapabilityValue('dim', parseFloat(action.value));
      case 'set_color_temp':
        return dev(action.deviceId).setCapabilityValue('light_temperature', parseFloat(action.value));
      case 'set_capability':
        return dev(action.deviceId).setCapabilityValue(action.capability, action.value);
      case 'fade_to': {
        const device = dev(action.deviceId);
        const target = Math.max(0, Math.min(1, parseFloat(action.value) || 1));
        const durMs  = Math.round((parseFloat(action.duration) || 0) * 1000);
        if (durMs <= 0) return device.setCapabilityValue('dim', target);
        // Only snap to 0 if the light was OFF when this action batch started.
        // Skipping the snap prevents the visible blink when lights are already on.
        if (!initiallyOn.has(action.deviceId)) {
          await device.setCapabilityValue('dim', 0, { duration: 0 }).catch(() => {});
          await new Promise(r => this.homey.setTimeout(r, 150));
        }
        return device.setCapabilityValue('dim', target, { duration: durMs });
      }
      case 'fade_off': {
        const device = dev(action.deviceId);
        const durMs  = Math.round((parseFloat(action.duration) || 0) * 1000);
        if (durMs <= 0) return device.setCapabilityValue('onoff', false);
        // Let the device driver handle the smooth dim-down
        await device.setCapabilityValue('dim', 0, { duration: durMs });
        // Wait for transition to finish, then cut power
        await new Promise(r => this.homey.setTimeout(r, durMs + 200));
        return device.setCapabilityValue('onoff', false);
      }
      case 'run_group': {
        const allAutos = this._getAutomations().filter(
          a => a._groupId === action.groupId && a.enabled !== false
        );
        const offTypes = new Set(['motion_stop', 'door_close', 'switch_off']);
        const target = allAutos.find(a => !a.trigger || !offTypes.has(a.trigger.type)) || allAutos[0];
        if (!target) throw new Error(`No automation found in group: ${action.groupId}`);
        return this._runActions(target.actions || [], target.name);
      }
      case 'override_group':
        return this._doOverride(
          action.groupId,
          action.brightness != null ? action.brightness : 1,
          action.durationMinutes || 30
        );
      case 'notify':
        return this.homey.notifications.createNotification({ excerpt: String(action.message) });
      case 'wait': {
        const ms = (parseInt(action.seconds, 10) || 1) * 1000;
        return new Promise(r => this.homey.setTimeout(r, ms));
      }
      default:
        throw new Error(`Unknown action type: ${action.type}`);
    }
  }

  //  Room trigger stubs (called by device.js)

  triggerRoomOccupied(device) {
    this._addLog('trigger', `Room "${device.getName()}" became occupied`);
    return Promise.resolve();
  }

  triggerRoomEmpty(device) {
    this._addLog('trigger', `Room "${device.getName()}" became empty`);
    return Promise.resolve();
  }

  triggerMotionTimeout(device) {
    this._addLog('trigger', `Room "${device.getName()}" motion timeout`);
    return Promise.resolve();
  }

  //  Log

  _addLog(level, message) {
    this._log.push({ ts: new Date().toISOString(), level, message });
    if (this._log.length > 200) this._log.shift();
    if (level === 'error') this.error(message);
    else this.log(`[${level}] ${message}`);
    // Persist to settings so the settings page can read it via _hGet
    if (this._logSaveTimer) this.homey.clearTimeout(this._logSaveTimer);
    this._logSaveTimer = this.homey.setTimeout(() => {
      this.homey.settings.set('_appLog', JSON.stringify(this._log));
    }, 500);
  }

}

module.exports = EasyAutomationApp;