// Change the contract when the worker's Modelica input interface changes.
export const draftPrefix = 'microduck-lab-draft-v4-rigid-jaw-demo:';
const previousPrefixes = ['microduck-lab-draft-v3-native-walk:', 'microduck-lab-draft-v2-named:'];

// readOnly: a build without source editing runs the shipped sources. Drafts an editable
// build saved stay in storage untouched and are offered as previous drafts; none is used.
export function modelDrafts(storage, {readOnly = false} = {}) {
  const read = key => {
    try { return storage.getItem(key); } catch { return null; }
  };
  const prefixes = readOnly ? [draftPrefix, ...previousPrefixes] : previousPrefixes;
  return {
    get: name => readOnly ? null : read(draftPrefix + name),
    set: (name, source) => { if (!readOnly) storage.setItem(draftPrefix + name, source); },
    remove: name => { if (!readOnly) storage.removeItem(draftPrefix + name); },
    previous: names => Object.fromEntries(names.flatMap(name => {
      const source = prefixes.map(prefix=>read(prefix + name)).find(value=>value!==null) ?? null;
      return source === null ? [] : [[name, source]];
    })),
  };
}
