// ui2/test/setup.ts — jsdom's Blob implements NEITHER text() nor arrayBuffer(): both are
// undefined on Blob.prototype, not merely on the object slice() returns. Every browser the
// cockpit runs in has shipped them since 2020, so this is an environment gap, not a product bug.
//
// It bites Library.tsx's endsLikePdf(), which reads a blob's tail to decide whether a .pdf really
// closes with %%EOF. Without these, that call throws, the loader's .catch(fail) wins, and the
// viewer renders its ERROR branch — so the two PDF tests failed on a missing method rather than
// on the behaviour they assert (both reported the same "b.slice(...).text is not a function").
//
// FileReader is what jsdom does implement, and it slices correctly, so these are faithful rather
// than stubs. Guarded, so each becomes a no-op the moment jsdom ships the real thing.
const read = <T>(blob: Blob, start: (r: FileReader, b: Blob) => void): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as T);
    r.onerror = () => reject(r.error);
    start(r, blob);
  });

const proto = Blob.prototype as unknown as {
  text?: () => Promise<string>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
};

if (typeof proto.text !== "function") {
  proto.text = function (this: Blob) { return read<string>(this, (r, b) => r.readAsText(b)); };
}

if (typeof proto.arrayBuffer !== "function") {
  proto.arrayBuffer = function (this: Blob) {
    return read<ArrayBuffer>(this, (r, b) => r.readAsArrayBuffer(b));
  };
}
