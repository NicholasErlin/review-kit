// Pocket Tasks: a tiny in-memory task list. Seeded with fixed data so screenshots are repeatable.
const tasks = [
  { text: 'Book the dentist', done: false },
  { text: 'Renew passport photos', done: true },
  { text: 'Send the March invoice', done: false },
  { text: 'Water the plants', done: true },
  { text: 'Call the landlord about the boiler', done: false },
];

const list = document.getElementById('list');
const count = document.getElementById('count');

function render() {
  list.innerHTML = '';
  tasks.forEach((t, i) => {
    const li = document.createElement('li');
    li.className = 'task' + (t.done ? ' done' : '');
    li.innerHTML = `<label><input type="checkbox" ${t.done ? 'checked' : ''}> <span></span></label>
      <button class="remove" title="Delete">×</button>`;
    li.querySelector('span').textContent = t.text;
    li.querySelector('input').onchange = () => { t.done = !t.done; render(); };
    li.querySelector('.remove').onclick = () => { tasks.splice(i, 1); render(); };
    list.appendChild(li);
  });
  const left = tasks.filter((t) => !t.done).length;
  count.textContent = `${left} left`;
}

document.getElementById('add').onsubmit = (e) => {
  e.preventDefault();
  const input = document.getElementById('text');
  if (input.value.trim()) tasks.unshift({ text: input.value.trim(), done: false });
  input.value = '';
  render();
};

render();
