/**
 * Minimum-cost assignment for a rectangular matrix with rows <= columns.
 * Returns the selected column for every row. Uses the O(n^2 m) Hungarian
 * shortest-augmenting-path formulation and has no external dependency.
 */
export const hungarianAssignment = (cost: number[][]): number[] => {
  const rowCount = cost.length;
  if (rowCount === 0) return [];
  const columnCount = cost[0]?.length ?? 0;
  if (columnCount < rowCount || cost.some(row => row.length !== columnCount)) {
    throw new Error('Hungarian assignment requires a rectangular matrix with rows <= columns');
  }

  const u = new Array<number>(rowCount + 1).fill(0);
  const v = new Array<number>(columnCount + 1).fill(0);
  const p = new Array<number>(columnCount + 1).fill(0);
  const way = new Array<number>(columnCount + 1).fill(0);

  for (let row = 1; row <= rowCount; row++) {
    p[0] = row;
    let column0 = 0;
    const minValue = new Array<number>(columnCount + 1).fill(Infinity);
    const used = new Array<boolean>(columnCount + 1).fill(false);

    do {
      used[column0] = true;
      const row0 = p[column0];
      let delta = Infinity;
      let column1 = 0;
      for (let column = 1; column <= columnCount; column++) {
        if (used[column]) continue;
        const reducedCost = cost[row0 - 1][column - 1] - u[row0] - v[column];
        if (reducedCost < minValue[column]) {
          minValue[column] = reducedCost;
          way[column] = column0;
        }
        if (minValue[column] < delta) {
          delta = minValue[column];
          column1 = column;
        }
      }
      for (let column = 0; column <= columnCount; column++) {
        if (used[column]) {
          u[p[column]] += delta;
          v[column] -= delta;
        } else {
          minValue[column] -= delta;
        }
      }
      column0 = column1;
    } while (p[column0] !== 0);

    do {
      const column1 = way[column0];
      p[column0] = p[column1];
      column0 = column1;
    } while (column0 !== 0);
  }

  const assignment = new Array<number>(rowCount).fill(-1);
  for (let column = 1; column <= columnCount; column++) {
    if (p[column] > 0 && p[column] <= rowCount) assignment[p[column] - 1] = column - 1;
  }
  return assignment;
};
