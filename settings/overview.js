'use strict';

// Read-only presentation of the existing automation groups and Homey settings.
var Overview = {
  model: function(now) {
    now = now == null ? Date.now() : now;
    var computed = computeGroups();
    var entries = computed.groups.map(function(g, index) {
      return { id: g.id, name: g.name || i18n('overview_unnamed'), type: g.type,
        items: g.items, groupIndex: index, singleIndex: null };
    }).concat(computed.orphans.map(function(item) {
      return { id: item.a.id, name: item.a.name || i18n('overview_unnamed'),
        type: 'custom', items: [item], groupIndex: null, singleIndex: item.i };
    }));
    var byDevice = Object.create(null);
    State.devices.forEach(function(d) { byDevice[d.id] = d; });
    var rooms = Object.create(null);
    var counts = { active: 0, disabled: 0, partial: 0 };
    entries.forEach(function(entry) {
      var enabled = entry.items.filter(function(item) { return !!item.a.enabled; }).length;
      entry.status = enabled === 0 ? 'disabled' : enabled !== entry.items.length ? 'partial' : 'active';
      counts[entry.status]++;
      var targetZones = [], sensorZones = [], savedZone = '';
      entry.items.forEach(function(item) {
        if (item.a._zone) savedZone = item.a._zone;
        var sensor = byDevice[(item.a.trigger || {}).deviceId];
        if (sensor && sensor.zone && sensorZones.indexOf(sensor.zone) === -1) sensorZones.push(sensor.zone);
        (item.a.actions || []).forEach(function(action) {
          var device = byDevice[action.deviceId];
          if (device && device.zone && targetZones.indexOf(device.zone) === -1) targetZones.push(device.zone);
        });
      });
      var zones = targetZones.length ? targetZones : sensorZones;
      entry.room = savedZone || (zones.length === 1 ? zones[0]
        : zones.length > 1 ? i18n('overview_shared_rooms') : i18n('overview_no_room'));
      if (!rooms[entry.room]) rooms[entry.room] = { name: entry.room, entries: [] };
      rooms[entry.room].entries.push(entry);
    });
    return { entries: entries, counts: counts, total: entries.length,
      devices: State.devices.length,
      rooms: Object.keys(rooms).sort(function(a, b) { return a.localeCompare(b); }).map(function(name) { return rooms[name]; }) };
  },

  statusText: function(entry, now) {
    var text = i18n(entry.status === 'active' ? 'overview_active_single' : 'overview_' + entry.status);
    return text;
  },

  render: function() {
    if (!el('overview-rooms')) return;
    var model = Overview.model();
    el('overview-rooms').innerHTML = model.rooms.length ? model.rooms.map(function(room) {
      return '<section class="room-card"><div class="room-heading"><span class="room-icon" aria-hidden="true">⌂</span>' +
        '<h3>' + esc(room.name) + '</h3><span class="room-count">' + room.entries.length + '</span></div>' +
        room.entries.map(function(entry) {
          var index = entry.groupIndex == null ? 's-' + entry.singleIndex : 'g-' + entry.groupIndex;
          return '<button class="room-automation hy-nostyle" data-overview-entry="' + index + '" ' +
            'onclick="Overview.open(\'' + index + '\')"><span class="room-entry-icon" aria-hidden="true">' + groupIcon(entry) + '</span>' +
            '<span class="room-entry-body"><strong>' + esc(entry.name) + '</strong>' +
            '<span class="status-pill" data-overview-status="' + index + '"></span></span>' +
            '<span class="room-chevron" aria-hidden="true">›</span></button>';
        }).join('') + '</section>';
    }).join('') : '<div class="surface-card welcome-card"><span class="welcome-icon" aria-hidden="true">⌂</span>' +
      '<h3>' + i18n('overview_empty_title') + '</h3><p>' + i18n('overview_empty_body') + '</p>' +
      '<button class="btn btn-blue hy-nostyle" onclick="UI.tab(\'auto\')">' + i18n('overview_first_automation') + '</button></div>';
    Overview.updateStatus();
    Overview.renderEvents();
  },

  updateStatus: function() {
    if (!el('overview-total')) return;
    var now = Date.now(), model = Overview.model(now);
    el('overview-total').textContent = model.total;
    el('overview-active').textContent = model.counts.active;
    el('overview-disabled').textContent = model.counts.disabled + model.counts.partial;
    el('overview-devices').textContent = model.devices;
    el('overview-summary').textContent = model.total ? i18n('overview_summary')
      .replace('{0}', model.total).replace('{1}', model.rooms.length) : i18n('overview_ready');
    model.entries.forEach(function(entry) {
      var index = entry.groupIndex == null ? 's-' + entry.singleIndex : 'g-' + entry.groupIndex;
      var pill = document.querySelector('[data-overview-status="' + index + '"]');
      if (pill) { pill.className = 'status-pill ' + entry.status; pill.textContent = Overview.statusText(entry, now); }
    });
    var connection = el('connection-status');
    connection.textContent = i18n(State.syncError ? 'overview_sync_error' : State.loaded ? 'overview_connected' : 'overview_loading');
    connection.className = 'connection-banner' + (State.syncError ? ' error' : State.loaded ? ' ready' : '');
  },

  renderEvents: function() {
    var logs = Array.isArray(State.logs) ? State.logs.slice(-4).reverse() : [];
    el('overview-events').innerHTML = logs.length ? logs.map(function(log) {
      var date = new Date(log.ts), time = isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
      return '<div class="event-row"><time>' + esc(time) + '</time><span class="event-level ' +
        (['error', 'warn', 'action', 'trigger'].indexOf(log.level) !== -1 ? log.level : 'info') + '">' +
        esc(log.level) + '</span><p>' + esc(log.message) + '</p></div>';
    }).join('') : '<p class="hint">' + i18n('overview_no_events') + '</p>';
  },

  open: function(index) {
    // Resolve against the current list so an edited/deleted group never opens a stale item.
    AutoList._computed = computeGroups();
    if (index.slice(0, 2) === 'g-') AutoList.editGroup(Number(index.slice(2)));
    else CustomEditor.open(Number(index.slice(2)));
  }
};
