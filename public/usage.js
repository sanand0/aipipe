function escapeHTML(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function showUsage($usage, token, email) {
  const { cost, limit, days, usage } = await fetch("usage", { headers: { Authorization: `Bearer ${token}` } }).then(
    (r) => r.json(),
  );

  // Display usage summary and table
  $usage.innerHTML = /* html */ `
    <div class="card text-bg-primary shadow-lg mb-3">
      <div class="card-body">
        <h3 class="card-title h5">${escapeHTML(email)}</h3>
        <div class="card-text">
          Usage: <strong>${(cost * 100).toFixed(5)} / ${(limit * 100).toFixed(0)}</strong>
          cents every ${days} day(s)
        </div>
      </div>
    </div>
    <table class="table table-striped table-hover table-sm">
      <thead>
        <tr>
          <th>Date</th>
          <th>Cents</th>
        </tr>
      </thead>
      <tbody>
        ${usage
          .map(
            (day) => `
              <tr>
                <td>${escapeHTML(day.date)}</td>
                <td>${(day.cost * 100).toFixed(5)}</td>
              </tr>`,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

export { showUsage };
