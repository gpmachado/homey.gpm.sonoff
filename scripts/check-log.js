'use strict';

// Reads a `homey app run` log (ZCL_DEBUG on) and checks the BASIC-ZB1GSP and MINI-ZB2GS against
// docs/TESTE-REMOTO.md. Prints PASS / WARN / FAIL / INFO lines, no raw frames and no keys, so the
// summary is safe to paste. Exit code 1 when something FAILed.
//   node scripts/check-log.js logs/teste.log

const fs = require('node:fs');

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/check-log.js <log file>');
  process.exit(2);
}

// PowerShell's ">" writes UTF-16 with a BOM; Tee-Object and the shell redirect write UTF-8.
const raw = fs.readFileSync(file);
const text = (raw[0] === 0xff && raw[1] === 0xfe ? raw.toString('utf16le') : raw.toString('utf8'))
  .replace(/\x1b\[[0-9;]*m/g, '');

const results = [];
const add = (level, name, detail = '') => results.push({ level, name, detail });
const ms = iso => Date.parse(iso);
const hhmmss = t => new Date(t).toISOString().slice(11, 19) + 'Z';

// -- app lines of one driver: { t, msg, err } -----------------------------------------------------
function driverLines(driver) {
  const re = new RegExp(`^(\\S+Z) \\[(log|err)\\] \\[ManagerDrivers\\] \\[Driver:${driver}\\] \\[Device:[^\\]]+\\] (.*)$`, 'gm');
  return [...text.matchAll(re)].map(m => ({ t: ms(m[1]), err: m[2] === 'err', msg: m[3] }));
}

// -- 0xFC11 frames (ZCL_DEBUG): reports have no status byte, read responses have one ---------------
const SIZES = { 0x10: 1, 0x20: 1, 0x21: 2, 0x23: 4, 0x29: 2, 0x2b: 4 };
function decode(hex, withStatus) {
  const b = Buffer.from(hex.replace(/\s/g, ''), 'hex');
  const out = {};
  let i = 0;
  while (i + (withStatus ? 4 : 3) <= b.length) {
    const id = b.readUInt16LE(i);
    if (withStatus && b[i + 2] !== 0) { i += 3; continue; }
    const type = b[i + (withStatus ? 3 : 2)];
    const size = SIZES[type];
    const start = i + (withStatus ? 4 : 3);
    if (!size || start + size > b.length) break;
    out[id] = size === 4 ? b.readUInt32LE(start) : size === 2 ? b.readUInt16LE(start) : b[start];
    i = start + size;
  }
  return out;
}
const frameRe = /(\S+Z) zigbee-clusters:cluster ep: \d, cl: SonoffCluster \(64529\) received frame (reportAttributes|readAttributesStructured\.response) \S+ \{\s*attributes: <Buffer ([0-9a-f ]+?)(?: \.\.\. \d+ more bytes)?>/g;
const frames = [...text.matchAll(frameRe)].map(m => ({
  t: ms(m[1]), report: m[2] === 'reportAttributes', attrs: decode(m[3], m[2] !== 'reportAttributes'),
}));
const POWER = 0x7006; const CURRENT = 0x7004; const VOLTAGE = 0x7005; const FAULT = 0x0010; const TOTAL = 0x701e;

// -- version ---------------------------------------------------------------------------------------
const version = text.match(/My Sonoff Devices v(\S+) started \(ZCL_DEBUG (on|off)\)/);
if (!version) add('FAIL', 'version', 'no version line: the log is from a version older than 1.0.9 (git pull and run again)');
else add('INFO', 'version', `v${version[1]}, ZCL_DEBUG ${version[2]}`);
if (version?.[2] === 'off') add('WARN', 'frames', 'ZCL_DEBUG is off, so the frame checks below cannot see anything');

// -- BASIC-ZB1GSP -----------------------------------------------------------------------------------
const basic = driverLines('BASIC-ZB1GSP');
if (!basic.length) {
  add('INFO', 'BASIC-ZB1GSP', 'not in this log');
} else {
  const has = re => basic.filter(l => re.test(l.msg));
  has(/BASIC-ZB1GSP initialized/).length ? add('PASS', 'BASIC starts') : add('FAIL', 'BASIC starts', 'no "initialized" line');

  has(/Could not configure attribute reporting/).length
    ? add('FAIL', 'BASIC reports configured', has(/Could not configure attribute reporting/)[0].msg)
    : add(has(/configured attribute reporting \(endpoint: 1, cluster: SonoffCluster\)/).length ? 'PASS' : 'WARN', 'BASIC reports configured');

  const syncFails = has(/(attribute sync failed|Could not read SonoffCluster attributes) \(attempt (\d)\/3\)/)
    .map(l => Number(l.msg.match(/attempt (\d)\/3/)[1]));
  if (Math.max(0, ...syncFails) >= 3) add('FAIL', 'BASIC settings read at start', 'failed 3 times: the protection limits shown may not be the device ones');
  else if (syncFails.length) add('INFO', 'BASIC settings read at start', `failed ${syncFails.length}x, the retry worked`);
  else add('PASS', 'BASIC settings read at start');

  // relay from Homey
  const cmds = has(/^set onoff -> (true|false)/).map(l => ({ t: l.t, on: /true/.test(l.msg) }));
  const reports = has(/handle report \(cluster: onOff.*parsed payload: (true|false)/).map(l => ({ t: l.t, on: /true$/.test(l.msg) }));
  const sawOn = reports.some(r => r.on); const sawOff = reports.some(r => !r.on);
  add(cmds.length && sawOn && sawOff ? 'PASS' : 'FAIL', 'BASIC relay on and off', `${cmds.length} commands, ${reports.length} onOff reports`);

  // power and current read soon after a relay change
  const reads = frames.filter(f => !f.report && f.attrs[POWER] !== undefined);
  const ons = cmds.filter(c => c.on);
  if (ons.length) {
    const ok = ons.filter(c => reads.some(f => f.t > c.t && f.t <= c.t + 15000 && f.attrs[POWER] >= 500)).length;
    add(ok === ons.length ? 'PASS' : ok ? 'WARN' : 'FAIL', 'BASIC power read after "on"', `${ok} of ${ons.length} showed power above 0.5 W within 15 s (needs a load)`);
  }

  // spontaneous reports
  const spont = frames.filter(f => f.report && (f.attrs[POWER] !== undefined || f.attrs[CURRENT] !== undefined || f.attrs[VOLTAGE] !== undefined));
  add(spont.length ? 'PASS' : 'WARN', 'BASIC reports on its own', spont.length
    ? `${spont.length} power/current/voltage reports`
    : 'none: remove the BASIC from Homey and pair it again with this version (the 0xFC11 binding is made at pairing)');

  // protection limits
  const writes = has(/Write OK on SonoffCluster ep1: (ac\w+Overload\w*)=/);
  const bad = basic.filter(l => /Error writing overload protection|REJECTED/.test(l.msg));
  add(bad.length ? 'FAIL' : writes.length ? 'PASS' : 'WARN', 'BASIC protection limits written', bad.length ? bad[0].msg : `${writes.length} writes`);

  // the relay opened by itself soon after "on" = a protection trip
  const trips = [];
  for (const c of ons) {
    const off = reports.find(r => !r.on && r.t > c.t && r.t <= c.t + 15000);
    const mine = cmds.find(x => !x.on && x.t > c.t && x.t <= (off?.t ?? 0));
    if (off && !mine) trips.push(hhmmss(off.t));
  }
  add('INFO', 'BASIC relay opened by itself', trips.length ? `${trips.length}x at ${trips.join(' ')}` : 'never (a limit has to be crossed to see it)');

  const faults = [...new Set(frames.filter(f => f.attrs[FAULT] !== undefined).map(f => '0x' + f.attrs[FAULT].toString(16).padStart(8, '0')))];
  add('INFO', 'BASIC fault_code values', faults.join(' ') || 'none seen');
  const total = Math.max(0, ...frames.map(f => f.attrs[TOTAL] ?? 0));
  add('INFO', 'BASIC energy total', `${total / 1000} kWh (stays 0 until a load runs a few minutes)`);
}

// -- MINI-ZB2GS -------------------------------------------------------------------------------------
const zb2 = driverLines('MINI-ZB2GS');
if (!zb2.length) {
  add('INFO', 'MINI-ZB2GS', 'not in this log');
} else {
  const has = re => zb2.filter(l => re.test(l.msg));
  const gangs = [1, 2].filter(g => has(new RegExp(`gang ${g} initialized`)).length);
  add(gangs.length === 2 ? 'PASS' : 'FAIL', 'ZB2GS both gangs start', `gangs up: ${gangs.join(', ') || 'none'}`);

  const cmds = has(/^set onoff -> (true|false) \(cluster: onOff, endpoint: (\d)\)/)
    .map(l => ({ t: l.t, ep: Number(l.msg.match(/endpoint: (\d)/)[1]) }));
  const reps = has(/handle report \(cluster: onOff, capability: onoff, ep(\d)\)/)
    .map(l => ({ t: l.t, ep: Number(l.msg.match(/ep(\d)\)/)[1]) }));
  for (const ep of [1, 2]) {
    const mine = cmds.filter(c => c.ep === ep);
    const ok = mine.filter(c => reps.some(r => r.ep === ep && r.t >= c.t && r.t <= c.t + 3000)).length;
    add(mine.length && ok === mine.length ? 'PASS' : 'WARN', `ZB2GS gang ${ep} from Homey`, mine.length ? `${ok} of ${mine.length} commands answered by a report in 3 s` : 'no command seen: turn this gang on and off from Homey');
  }
  const wrong = cmds.filter(c => !reps.some(r => r.ep === c.ep && r.t >= c.t && r.t <= c.t + 3000)
    && reps.some(r => r.ep !== c.ep && r.t >= c.t && r.t <= c.t + 3000)).length;
  if (wrong) add('FAIL', 'ZB2GS wrong gang', `${wrong} commands were answered by the other gang`);

  for (const ep of [1, 2]) {
    const physical = reps.filter(r => r.ep === ep && !cmds.some(c => c.ep === ep && r.t >= c.t && r.t <= c.t + 3000)).length;
    add(physical ? 'PASS' : 'WARN', `ZB2GS gang ${ep} wall button`, physical ? `${physical} reports without a Homey command` : 'press the button of this gang once');
  }

  const rejoins = has(/Firing flow: MINI-ZB2GS_device_rejoined/).map(l => l.t);
  const twice = rejoins.some((t, i) => i && t - rejoins[i - 1] < 30000);
  add(twice ? 'FAIL' : rejoins.length ? 'PASS' : 'WARN', 'ZB2GS power-cut trigger',
    twice ? 'two triggers within 30 s for one power cut' : rejoins.length ? `${rejoins.length} trigger(s) at ${rejoins.map(hhmmss).join(' ')}` : 'none: unplug and plug the device once');

  const writes = has(/Write OK on SonoffCluster ep\d/).map(l => l.t);
  const falseRejoin = rejoins.filter(r => writes.some(w => r > w && r - w < 30000));
  if (writes.length) add(falseRejoin.length ? 'FAIL' : 'PASS', 'ZB2GS settings write is not a rejoin', falseRejoin.length ? `trigger within 30 s of a write at ${falseRejoin.map(hhmmss).join(' ')} (or a power cut right after a write)` : `${writes.length} writes, no trigger`);
  else add('WARN', 'ZB2GS settings write is not a rejoin', 'no write seen: change a setting of gang 1 (switch mode or turbo)');

  const inchFail = zb2.filter(l => /Failed to set inching/.test(l.msg));
  const inch = has(/Sending inching command/).length;
  if (inchFail.length) add('FAIL', 'ZB2GS inching', inchFail[0].msg);
  else if (inch) add('PASS', 'ZB2GS inching', `${inch} command(s) sent`);

  const down = zb2.filter(l => /\[Availability\] Unavailable/.test(l.msg));
  add(down.length ? 'WARN' : 'PASS', 'ZB2GS stays available', down.length ? down.map(l => `${hhmmss(l.t)} ${l.msg}`).join(' | ') : 'never marked unavailable');
}

// -- errors of both drivers ----------------------------------------------------------------------
const errs = [...new Set([...basic, ...zb2].filter(l => l.err).map(l => l.msg.slice(0, 140)))];
add(errs.length ? 'WARN' : 'PASS', 'driver errors', errs.length ? errs.slice(0, 5).join(' | ') : 'none');

// -- print -----------------------------------------------------------------------------------------
for (const r of results) console.log(`${r.level.padEnd(5)} ${r.name}${r.detail ? ' - ' + r.detail : ''}`);
const count = lv => results.filter(r => r.level === lv).length;
console.log(`\n${count('PASS')} PASS, ${count('WARN')} WARN, ${count('FAIL')} FAIL`);
process.exit(count('FAIL') ? 1 : 0);
