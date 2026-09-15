const escapeText = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Helper: Parse clipboard HTML table to TipTap table format
export const parseHtmlTable = (html: string): string | null => {
  const template = document.createElement("template");
  template.innerHTML = html;
  const table = template.content.querySelector("table");
  if (!table) return null;

  const rows = table.querySelectorAll("tr");
  if (rows.length === 0) return null;

  // Build proper TipTap-compatible table structure
  let headerRow = "";
  let bodyRows = "";

  rows.forEach((row, rowIndex) => {
    const cells = row.querySelectorAll("th, td");
    if (cells.length === 0) return;

    let rowHtml = "<tr>";
    cells.forEach((cell) => {
      const text = cell.textContent?.trim() || "\u00A0"; // non-breaking space for empty cells
      if (rowIndex === 0) {
        rowHtml += `<th><p>${escapeText(text)}</p></th>`;
      } else {
        rowHtml += `<td><p>${escapeText(text)}</p></td>`;
      }
    });
    rowHtml += "</tr>";

    if (rowIndex === 0) {
      headerRow = rowHtml;
    } else {
      bodyRows += rowHtml;
    }
  });

  // TipTap Table requires tbody, thead is optional
  let result = "<table>";
  if (headerRow) {
    result += `<thead>${headerRow}</thead>`;
  }
  result += `<tbody>${bodyRows || headerRow}</tbody>`;
  result += "</table>";

  return result;
};

// Helper: Parse plain text table (tab/pipe separated)
export const parseTextTable = (text: string): string | null => {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return null;

  // Check if it looks like a table (has tabs or pipes)
  const hasTabsOrPipes = lines.some((line) => line.includes("\t") || line.includes("|"));
  if (!hasTabsOrPipes) return null;

  // Filter and parse rows
  const dataRows: string[][] = [];

  lines.forEach((line) => {
    // Skip Markdown separator line (|---|---|)
    if (/^\|?[\s\-:|]+\|?$/.test(line)) return;

    let cells: string[];
    if (line.includes("|")) {
      cells = line.split("|").map((c) => c.trim()).filter((c) => c);
    } else {
      cells = line.split("\t").map((c) => c.trim());
    }

    if (cells.length > 0) {
      dataRows.push(cells);
    }
  });

  if (dataRows.length === 0) return null;

  // Build TipTap-compatible table
  let result = "<table>";

  // First row as header
  result += "<thead><tr>";
  dataRows[0].forEach((cell) => {
    result += `<th><p>${escapeText(cell || "\u00A0")}</p></th>`;
  });
  result += "</tr></thead>";

  // Remaining rows as body
  result += "<tbody>";
  for (let i = 1; i < dataRows.length; i++) {
    result += "<tr>";
    dataRows[i].forEach((cell) => {
      result += `<td><p>${escapeText(cell || "\u00A0")}</p></td>`;
    });
    result += "</tr>";
  }
  // If only header, duplicate as body row (TipTap needs at least one body row)
  if (dataRows.length === 1) {
    result += "<tr>";
    dataRows[0].forEach((cell) => {
      result += `<td><p>${escapeText(cell || "\u00A0")}</p></td>`;
    });
    result += "</tr>";
  }
  result += "</tbody></table>";

  return result;
};

