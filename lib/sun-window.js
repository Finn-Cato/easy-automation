'use strict';

const SunCalc = require('suncalc');

// UTC instants work across midnight and daylight-saving changes. No location
// data is sent to a weather service or written to app settings.
module.exports = function sunWindow(now, location) {
  const latitude = location && location.latitude;
  const longitude = location && location.longitude;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    throw new Error('Homey location is unavailable; check Homey location settings');
  }
  const times = SunCalc.getTimes(new Date(now), latitude, longitude);
  const sunrise = times.sunrise && times.sunrise.getTime();
  const sunset = times.sunset && times.sunset.getTime();
  const isNight = times.alwaysDown || (!times.alwaysUp && (now < sunrise || now >= sunset));
  const rises = [sunrise];
  for (let offset = 1; offset <= 2; offset++) {
    const next = SunCalc.getTimes(new Date(now + offset * 86400000), latitude, longitude).sunrise;
    if (next) rises.push(next.getTime());
  }
  const nextSunrise = rises.filter(time => Number.isFinite(time) && time > now).sort((a, b) => a - b)[0] || null;
  return { isNight: !!isNight, sunrise: sunrise || null, sunset: sunset || null, nextSunrise };
};
