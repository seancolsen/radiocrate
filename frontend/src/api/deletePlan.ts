// The deletion planner's link to the database (`record/deletePlan.ts`): its
// questions go out as raw SQL, as the playlist's own reads do. No Querydown is
// needed to list the rows of one table that hold given values, and the tables
// can be in any schema.

import { runSql } from "./query";
import { planQuerySql, type PlanQuery } from "../record/deletePlan";

/** Answers one of the planner's questions: every cell as text. */
export function loadPlanRows(query: PlanQuery): Promise<(string | null)[][]> {
  return loadSqlRows(planQuerySql(query));
}

/** Runs `sql`, giving every cell as text, `null` for NULL. */
export async function loadSqlRows(sql: string): Promise<(string | null)[][]> {
  const table = await runSql(sql);
  const columns = table.schema.fields.map((_, i) => table.getChildAt(i));
  const rows: (string | null)[][] = [];
  for (let row = 0; row < table.numRows; row++) {
    rows.push(
      columns.map((column) => {
        const value: unknown = column?.get(row);
        return value == null ? null : String(value);
      }),
    );
  }
  return rows;
}
