// Settings window. Talks to the main process through window.vc.settings (preload.cjs).
const api = window.vc.settings;
const $ = (id) => document.getElementById(id);
let state;

// ---- tabs
for (const tab of document.querySelectorAll('nav [role=tab]')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('nav [role=tab]')) t.setAttribute('aria-selected', String(t === tab));
    for (const s of document.querySelectorAll('main section')) s.classList.toggle('on', s.id === tab.dataset.tab);
    $('save').hidden = !['general', 'voice'].includes(tab.dataset.tab);
  });
}

function status(text, ok = false) {
  $('status').textContent = text;
  $('status').className = ok ? 'ok' : '';
}

// ---- settings form
const fields = [...document.querySelectorAll('[data-key]')];

function fillForm(cfg) {
  for (const el of fields) {
    const v = cfg[el.dataset.key];
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v ?? '';
  }
  $('title').textContent = `${cfg.assistantName || 'Nova'} settings`;
  document.title = `${cfg.assistantName || 'Nova'} settings`;
}

function readForm() {
  const out = {};
  for (const el of fields) {
    const key = el.dataset.key;
    if (el.type === 'checkbox') out[key] = el.checked;
    else if (el.type === 'number') {
      // An emptied box keeps the saved value instead of becoming 0.
      if (el.value.trim() !== '' && Number.isFinite(Number(el.value))) out[key] = Number(el.value);
    }
    else out[key] = el.value;
  }
  return out;
}

fields.forEach((el) => el.addEventListener('input', () => status('Unsaved changes')));

$('save').addEventListener('click', async () => {
  $('save').disabled = true;
  try {
    const res = await api.save(readForm());
    render(res);
    status(res.notes?.length ? res.notes.join(' ') : 'Saved.', !res.notes?.length);
  } catch (e) {
    status(`Couldn't save: ${e.message}`);
  } finally {
    $('save').disabled = false;
  }
});
$('openFile').addEventListener('click', () => api.openFile());

// ---- lists
function li(main, sub, onRemove, removeLabel) {
  const item = document.createElement('li');
  const what = document.createElement('div');
  what.className = 'what';
  what.textContent = main;
  if (sub) {
    const s = document.createElement('div');
    s.className = 'sub';
    s.textContent = sub;
    what.append(s);
  }
  const btn = document.createElement('button');
  btn.className = 'link';
  btn.textContent = 'Remove';
  btn.setAttribute('aria-label', removeLabel);
  btn.addEventListener('click', onRemove);
  item.append(what, btn);
  return item;
}

function fillList(ul, items, emptyText) {
  ul.replaceChildren(...items);
  if (!items.length) {
    const e = document.createElement('li');
    e.className = 'empty';
    e.textContent = emptyText;
    ul.append(e);
  }
}

function render(s) {
  state = s;
  if (s.config) fillForm(s.config);
  fillList($('memoryList'), s.memory.map((f) => li(f.text, `Saved ${new Date(f.at).toLocaleDateString()}`, async () => render(await api.forget(f.text)), `Forget: ${f.text}`)), 'Nothing remembered yet.');
  const routines = Object.entries(s.routines);
  fillList($('routineList'), routines.map(([name, steps]) => {
    const item = li(name, steps.join('  →  '), async () => render(await api.deleteRoutine(name)), `Delete routine ${name}`);
    item.querySelector('.what').style.cursor = 'pointer';
    item.querySelector('.what').title = 'Click to edit';
    item.querySelector('.what').addEventListener('click', () => { $('routineName').value = name; $('routineSteps').value = steps.join('\n'); $('routineName').focus(); });
    return item;
  }), 'No routines yet. Make one below, or say "when I say standup, open Linear and my notes".');
  fillList($('reminderList'), s.reminders.map((r) => li(r.text, r.kind === 'timer' ? 'Timer' : '', async () => render(await api.cancelReminder(r.id)), `Cancel: ${r.text}`)), 'Nothing scheduled.');
  $('n-memory').textContent = s.memory.length || '';
  $('n-routines').textContent = routines.length || '';
  $('n-reminders').textContent = s.reminders.length || '';
}

$('memoryForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('memoryInput').value.trim();
  if (!text) return;
  render(await api.addMemory(text));
  $('memoryInput').value = '';
});

$('routineForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('routineName').value.trim();
  const steps = $('routineSteps').value.split('\n').map((x) => x.trim()).filter(Boolean);
  if (!name || !steps.length) return status('A routine needs a name and at least one step.');
  render(await api.saveRoutine(name, steps));
  $('routineName').value = '';
  $('routineSteps').value = '';
  status(`Saved. Say "start ${name}".`, true);
});

// Lists change when you talk to her (or a reminder goes off): keep them fresh, but don't
// overwrite settings you're in the middle of editing.
async function refreshLists() {
  const s = await api.get();
  render({ ...s, config: $('status').textContent === 'Unsaved changes' ? null : s.config });
}
window.vc.on('settings-changed', refreshLists);
setInterval(refreshLists, 5000);

api.get().then(render);
