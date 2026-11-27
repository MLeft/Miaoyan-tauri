export function pathIdentity(path: string): string {
  const windows = /^[a-z]:[\\/]/i.test(path) || /^[\\/]{2}/.test(path);
  let key = windows ? path.replace(/\\/g, '/') : path;
  if (windows) {
    key = key.replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\//, '').toLowerCase();
  }
  if (key === '/' || /^[a-z]:\/$/.test(key)) return key;
  return key.replace(/\/+$/, '');
}

export function isPathWithin(path: string, root: string): boolean {
  const key = pathIdentity(path), parent = pathIdentity(root);
  if (parent === '') return false;
  return key === parent || key.startsWith(parent.endsWith('/') ? parent : parent + '/');
}
