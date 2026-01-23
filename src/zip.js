import { unzip, zip } from 'fflate';

export async function unzipBuffer(arrayBuffer) {
  return new Promise((resolve, reject) => {
    const u8 = new Uint8Array(arrayBuffer);
    unzip(u8, (err, unzipped) => {
      if (err) return reject(err);
      // fflate returns an object { filename: Uint8Array }
      // Convert to Map for easier handling
      const map = new Map(Object.entries(unzipped));
      resolve(map);
    });
  });
}

export async function zipFiles(map) {
  return new Promise((resolve, reject) => {
    const obj = Object.fromEntries(map);
    zip(obj, { level: 6 }, (err, data) => {
      if (err) return reject(err);
      resolve(data);
    });
  });
}