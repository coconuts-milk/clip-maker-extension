// 小さな MP4 の組み立て（ふつうの mp4 = ftyp + moov + mdat。断片化しない）。
// WebCodecs で作った H.264 と AAC のサンプルを受け取り、コマごとの時刻をそのまま書く。
// MediaRecorder の mp4 は断片化していて時刻が取り込み時の時計で付くため、コマの間隔が揺れる・サービスによっては弾かれる。
//
// buildMp4({ video: { samples: [{ts, dur, key, data}], description, width, height },
//            audio: { samples: [{ts, dur, data}], description, sampleRate, channels } | null })
//   ts / dur はマイクロ秒。description は avcC（映像）/ AudioSpecificConfig（音声）のバイト列。
//   返り値: Uint8Array

const MP4_VIDEO_TIMESCALE = 90000;

function buildMp4(spec) {
  const enc = new TextEncoder();
  const parts = [];        // 書き出し用の Uint8Array 列
  let total = 0;
  const push = u8 => { parts.push(u8); total += u8.length; };

  // ---- バイト列の部品 ----
  const u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; };
  const u16 = n => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n & 0xffff); return b; };
  const u8 = n => new Uint8Array([n & 0xff]);
  const str = s => enc.encode(s);
  const zeros = n => new Uint8Array(n);
  const cat = (...arrs) => {
    const flat = arrs.flat(Infinity);
    const n = flat.reduce((s, a) => s + a.length, 0);
    const out = new Uint8Array(n);
    let o = 0;
    for (const a of flat) { out.set(a, o); o += a.length; }
    return out;
  };
  const box = (type, ...payload) => { const body = cat(...payload); return cat(u32(8 + body.length), str(type), body); };
  const full = (type, version, flags, ...payload) => box(type, u8(version), u8((flags >> 16) & 0xff), u8((flags >> 8) & 0xff), u8(flags & 0xff), ...payload);
  const fixed16 = n => u32(Math.round(n * 65536));
  const toScale = (us, scale) => Math.round(us * scale / 1e6);
  const matrix = cat(u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000));

  // ---- サンプル表 ----
  // 各サンプルの長さ（stts）: 次のサンプルとの時刻差。最後は自分の dur
  const durations = (samples, scale) => samples.map((s, i) => Math.max(1, i + 1 < samples.length ? toScale(samples[i + 1].ts - s.ts, scale) : toScale(s.dur, scale)));
  const stts = durs => {
    const runs = [];
    for (const d of durs) { if (runs.length && runs[runs.length - 1][1] === d) runs[runs.length - 1][0]++; else runs.push([1, d]); }
    return full("stts", 0, 0, u32(runs.length), ...runs.map(([n, d]) => cat(u32(n), u32(d))));
  };
  const stsz = samples => full("stsz", 0, 0, u32(0), u32(samples.length), ...samples.map(s => u32(s.data.length)));
  const stsc = () => full("stsc", 0, 0, u32(1), u32(1), u32(1), u32(1));   // 1 サンプル = 1 チャンク
  const stco = offsets => full("stco", 0, 0, u32(offsets.length), ...offsets.map(o => u32(o)));
  const stss = samples => {
    const keys = samples.map((s, i) => s.key ? i + 1 : 0).filter(Boolean);
    return full("stss", 0, 0, u32(keys.length), ...keys.map(k => u32(k)));
  };

  // ---- 共通の trak ----
  const trak = (id, durMovie, tkhdExtra, mdhdScale, durMedia, hdlrType, hdlrName, mediaHeader, sampleEntry, tables) => box("trak",
    full("tkhd", 0, 3, u32(0), u32(0), u32(id), u32(0), u32(durMovie), zeros(8), u16(0), u16(0), tkhdExtra.volume, u16(0), matrix, tkhdExtra.width, tkhdExtra.height),
    box("mdia",
      full("mdhd", 0, 0, u32(0), u32(0), u32(mdhdScale), u32(durMedia), u16(0x55c4), u16(0)),   // 言語 "und"
      full("hdlr", 0, 0, u32(0), str(hdlrType), zeros(12), str(hdlrName), u8(0)),
      box("minf", mediaHeader,
        box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1))),
        box("stbl", full("stsd", 0, 0, u32(1), sampleEntry), ...tables))));

  // ---- 映像 ----
  const v = spec.video;
  const vDurs = durations(v.samples, MP4_VIDEO_TIMESCALE);
  const vMediaDur = vDurs.reduce((a, b) => a + b, 0);
  const avc1 = (offsetsV) => box("avc1", zeros(6), u16(1), u16(0), u16(0), zeros(12), u16(v.width), u16(v.height),
    u32(0x00480000), u32(0x00480000), u32(0), u16(1), zeros(32), u16(0x0018), u16(0xffff),
    box("avcC", new Uint8Array(v.description)));

  // ---- 音声 ----
  const a = spec.audio;
  let aDurs = [], aMediaDur = 0;
  if (a) { aDurs = durations(a.samples, a.sampleRate); aMediaDur = aDurs.reduce((x, y) => x + y, 0); }
  const esds = () => {
    const asc = new Uint8Array(a.description);
    const dsi = cat(u8(0x05), u8(asc.length), asc);                                           // DecoderSpecificInfo
    const dcd = cat(u8(0x04), u8(13 + dsi.length), u8(0x40), u8(0x15), zeros(3), u32(0), u32(0), dsi);   // DecoderConfig: AAC, audio stream
    const sl = cat(u8(0x06), u8(1), u8(0x02));                                                 // SLConfig
    const es = cat(u8(0x03), u8(3 + dcd.length + sl.length), u16(1), u8(0), dcd, sl);           // ES_Descriptor
    return full("esds", 0, 0, es);
  };
  const mp4a = () => box("mp4a", zeros(6), u16(1), u16(0), u16(0), u32(0), u16(a.channels), u16(16), u16(0), u16(0), fixed16(a.sampleRate), esds());

  // ---- mdat の並び: 時刻順に 1 サンプル 1 チャンク ----
  const order = [];
  v.samples.forEach((s, i) => order.push({ track: "v", i, ts: s.ts, data: s.data }));
  if (a) a.samples.forEach((s, i) => order.push({ track: "a", i, ts: s.ts, data: s.data }));
  order.sort((x, y) => x.ts - y.ts || (x.track === "v" ? -1 : 1));
  const mdatSize = 8 + order.reduce((s, o) => s + o.data.length, 0);

  // moov の大きさを先に決めるため、オフセットは「ftyp + moov の後」から数える。moov は stco を含むので 2 回組む（1 回目は仮の 0）
  const ftyp = box("ftyp", str("isom"), u32(0x200), str("isom"), str("iso2"), str("avc1"), str("mp41"));
  const movieScale = 1000;
  const movieDur = Math.round(Math.max(vMediaDur / MP4_VIDEO_TIMESCALE, a ? aMediaDur / a.sampleRate : 0) * movieScale);
  const buildMoov = (offV, offA) => box("moov",
    full("mvhd", 0, 0, u32(0), u32(0), u32(movieScale), u32(movieDur), u32(0x00010000), u16(0x0100), zeros(10), matrix, zeros(24), u32(a ? 3 : 2)),
    trak(1, movieDur, { volume: u16(0), width: fixed16(v.width), height: fixed16(v.height) }, MP4_VIDEO_TIMESCALE, vMediaDur, "vide", "VideoHandler",
      full("vmhd", 0, 1, zeros(8)), avc1(), [stts(vDurs), stss(v.samples), stsc(), stsz(v.samples), stco(offV)]),
    ...(a ? [trak(2, movieDur, { volume: u16(0x0100), width: u32(0), height: u32(0) }, a.sampleRate, aMediaDur, "soun", "SoundHandler",
      full("smhd", 0, 0, u32(0)), mp4a(), [stts(aDurs), stsc(), stsz(a.samples), stco(offA)])] : []));
  const moovSize = buildMoov(v.samples.map(() => 0), a ? a.samples.map(() => 0) : []).length;
  const base = ftyp.length + moovSize + 8;
  const offV = new Array(v.samples.length), offA = a ? new Array(a.samples.length) : [];
  let pos = base;
  for (const o of order) { (o.track === "v" ? offV : offA)[o.i] = pos; pos += o.data.length; }
  const moov = buildMoov(offV, offA);
  if (moov.length !== moovSize) throw new Error("mp4 の moov の大きさが合いません");

  push(ftyp); push(moov);
  push(u32(mdatSize)); push(str("mdat"));
  for (const o of order) push(o.data);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
