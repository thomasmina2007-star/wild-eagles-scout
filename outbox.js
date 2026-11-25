/* Wild Eagles Scout — offline outbox for attendance marks.
   Loaded before app.js. Queues marks taken with no internet and applies them
   optimistically to the attendance view; app.js flushes the queue when the
   connection is back. The server writes are idempotent (one record per member
   per week), so retries can never duplicate a mark. */
var WESOutbox = (function () {
  var KEY = 'wes_outbox_v1';
  var store = (typeof localStorage !== 'undefined') ? localStorage : (function () {
    var m = {};
    return {
      getItem: function (k) { return (k in m) ? m[k] : null; },
      setItem: function (k, v) { m[k] = String(v); },
      removeItem: function (k) { delete m[k]; }
    };
  })();

  function all() {
    try { return JSON.parse(store.getItem(KEY) || '[]'); } catch (e) { return []; }
  }
  function save(q) { store.setItem(KEY, JSON.stringify(q)); }

  function sameMark(a, b) {
    return a.action === 'mark' && b.action === 'mark' && a.memberId === b.memberId && a.date === b.date;
  }
  function sameAll(a, b) {
    return a.action === 'markAll' && b.action === 'markAll' && a.date === b.date && (a.team || '') === (b.team || '');
  }

  /* Latest status wins: queueing a new mark for the same member+date replaces the old one. */
  function enqueue(op) {
    var q = all().filter(function (x) { return !sameMark(x, op) && !sameAll(x, op); });
    q.push(op);
    save(q);
    return q.length;
  }

  function shift() { var q = all(); q.shift(); save(q); return q.length; }
  function requeue() { var q = all(); if (q.length > 1) { q.push(q.shift()); save(q); } }
  function clear() { save([]); }
  function count() { return all().length; }

  /* Overlay pending marks onto a week response so the UI reflects them immediately. */
  function applyToWeek(w) {
    if (!w || !w.teams) return w;
    all().forEach(function (op) {
      if (op.date && w.markDate && op.date !== w.markDate) return;
      if (op.action === 'mark') {
        w.teams.forEach(function (t) {
          t.members.forEach(function (m) { if (m.id === op.memberId) m.mark = op.status; });
        });
      } else if (op.action === 'markAll') {
        w.teams.forEach(function (t) {
          if (op.team && t.team !== op.team) return;
          t.members.forEach(function (m) { m.mark = op.status; });
        });
      }
    });
    var n = 0, tot = 0;
    w.teams.forEach(function (t) {
      t.members.forEach(function (m) { tot++; if (m.mark) n++; });
    });
    w.marked = n;
    w.total = tot;
    return w;
  }

  return { all: all, enqueue: enqueue, shift: shift, requeue: requeue, clear: clear, count: count, applyToWeek: applyToWeek };
})();
