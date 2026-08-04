(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.MDNotesMerge = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  // A quadratic line diff is a deliberately conservative trade-off here. Large
  // notes fall back to a conflict copy instead of tying up the browser trying
  // to guess at a merge.
  const maxDiffCells = 1000000;

  function equalArrays(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }

  function diffHunks(base, changed) {
    const baseLines = String(base).split('\n');
    const changedLines = String(changed).split('\n');
    const rows = baseLines.length;
    const columns = changedLines.length;
    if (rows * columns > maxDiffCells) return null;

    const table = Array.from({length: rows + 1}, () => new Uint16Array(columns + 1));
    for (let row = rows - 1; row >= 0; row--) {
      for (let column = columns - 1; column >= 0; column--) {
        table[row][column] = baseLines[row] === changedLines[column]
          ? table[row + 1][column + 1] + 1
          : Math.max(table[row + 1][column], table[row][column + 1]);
      }
    }

    const hunks = [];
    let row = 0;
    let column = 0;
    while (row < rows || column < columns) {
      if (row < rows && column < columns && baseLines[row] === changedLines[column]) {
        row++;
        column++;
        continue;
      }
      const start = row;
      const replacement = [];
      while (row < rows || column < columns) {
        if (row < rows && column < columns && baseLines[row] === changedLines[column]) break;
        if (column < columns && (row === rows || table[row][column + 1] > table[row + 1][column])) {
          replacement.push(changedLines[column++]);
        } else {
          row++;
        }
      }
      hunks.push({start, end: row, replacement});
    }
    return {baseLines, hunks};
  }

  function equalHunks(left, right) {
    return left.start === right.start && left.end === right.end && equalArrays(left.replacement, right.replacement);
  }

  function hunksOverlap(left, right) {
    if (left.start === right.start) return true;
    const earlier = left.start < right.start ? left : right;
    const later = earlier === left ? right : left;
    return earlier.end > later.start;
  }

  function mergeText(base, local, remote) {
    base = String(base ?? '');
    local = String(local ?? '');
    remote = String(remote ?? '');
    if (local === remote) return local;
    if (local === base) return remote;
    if (remote === base) return local;

    const localDiff = diffHunks(base, local);
    const remoteDiff = diffHunks(base, remote);
    if (!localDiff || !remoteDiff) return null;

    const duplicateRemoteHunks = new Set();
    for (const localHunk of localDiff.hunks) {
      for (let index = 0; index < remoteDiff.hunks.length; index++) {
        const remoteHunk = remoteDiff.hunks[index];
        if (equalHunks(localHunk, remoteHunk)) {
          duplicateRemoteHunks.add(index);
        } else if (hunksOverlap(localHunk, remoteHunk)) {
          return null;
        }
      }
    }

    const changes = [
      ...localDiff.hunks,
      ...remoteDiff.hunks.filter((_, index) => !duplicateRemoteHunks.has(index)),
    ].sort((left, right) => left.start - right.start || left.end - right.end);

    const result = [];
    let cursor = 0;
    for (const change of changes) {
      result.push(...localDiff.baseLines.slice(cursor, change.start), ...change.replacement);
      cursor = change.end;
    }
    result.push(...localDiff.baseLines.slice(cursor));
    return result.join('\n');
  }

  function mergeValue(base, local, remote) {
    if (local === remote) return local;
    if (local === base) return remote;
    if (remote === base) return local;
    return null;
  }

  function mergeNoteVersions(base, local, remote) {
    const title = mergeValue(base.title || '', local.title || '', remote.title || '');
    const tags = mergeValue(base.tags || '', local.tags || '', remote.tags || '');
    const content = mergeText(base.content || '', local.content || '', remote.content || '');
    if (title === null || tags === null || content === null) return null;
    return {title, tags, content};
  }

  return {mergeText, mergeNoteVersions};
});
