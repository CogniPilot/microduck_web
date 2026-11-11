// Change the contract when the worker's Modelica input interface changes.
export const draftPrefix = 'microduck-lab-draft-v4-rigid-jaw-demo:';
const previousPrefixes = ['microduck-lab-draft-v3-native-walk:', 'microduck-lab-draft-v2-named:'];

export function modelDrafts(storage) {
  const read = key => {
    try { return storage.getItem(key); } catch { return null; }
  };
  return {
    get: name => read(draftPrefix + name),
    set: (name, source) => storage.setItem(draftPrefix + name, source),
    remove: name => storage.removeItem(draftPrefix + name),
    previous: names => Object.fromEntries(names.flatMap(name => {
      const source = previousPrefixes.map(prefix=>read(prefix + name)).find(value=>value!==null) ?? null;
      return source === null ? [] : [[name, source]];
    })),
  };
}
