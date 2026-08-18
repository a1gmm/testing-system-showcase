import { Buffer } from 'node:buffer'

export function detectImageMime(bytes: Uint8Array): string | null {
  const b=Buffer.from(bytes)
  if(b.length>=3&&b[0]===0xff&&b[1]===0xd8&&b[2]===0xff)return'image/jpeg'
  if(b.length>=8&&b.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])))return'image/png'
  if(b.length>=12&&b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP')return'image/webp'
  if(b.length>=12&&b.subarray(4,8).toString()==='ftyp'&&/^(heic|heix|hevc|hevx|mif1|msf1)$/.test(b.subarray(8,12).toString()))return'image/heic'
  return null
}
