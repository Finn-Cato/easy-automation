Easy Automation
===============

Easy Automation lets you create room-based automations for lights, switches,
doors, and other devices — all configured directly inside the app's settings
page. No flows needed.

How it works
------------
1. Add one or more "Room" devices in Homey.
2. Open the app settings page and create automations for each room.
3. Each automation listens to a trigger (motion detected, door opened, a
   switch turned on, etc.) and runs a set of actions (turn on/dim lights,
   lock a door, send a notification, and more).
4. The room device tracks occupancy (motion active/inactive) and whether
   automation is currently enabled — both visible as device capabilities.

Key features
------------
- Motion-based light control with configurable timeout (1–120 minutes)
- Door and switch triggers
- Adjustable light brightness and colour temperature per automation
- Hold / override support — temporarily pause automation for a room
- Automation groups: trigger a whole group of automations from a single
  Homey Flow action card
- Built-in activity log visible in the settings page
- Works on both local and cloud Homey platforms

Flow integration
----------------
Even though flows are not required, Easy Automation exposes one Flow action:

  "Run automation group" — manually trigger any named automation group
  from a Homey Flow, Advanced Flow, or another app.

Requirements
------------
- Homey firmware 5.0.0 or newer

Support
-------
For questions or bug reports, contact: fca@finnlyden.no
Source code: https://github.com/Finn-Cato/easy-automation
