//! `Array.prototype.sort(comparefn)` as V8 implements it.
//!
//! With a consistent comparator every stable sort gives the same order, and
//! Rust's `sort_by` would do. The TypeScript reference sorts with
//! `(a, b) => a.x - b.x` over numbers it read from a file, and a `NaN` among
//! them (`Number("abc")`) makes the comparator inconsistent: the spec turns a
//! `NaN` result into `+0`, "equal", so a `NaN` element is equal to everything
//! while the others are not equal to each other. The order that comes out is
//! then whatever the engine's algorithm makes of it. V8's is TimSort
//! (`third_party/v8/builtins/array-sort.tq`, a port of CPython's
//! `listsort`): runs found by `CountAndMakeRun`, extended to `minrun` by
//! binary insertion, merged with galloping (`MergeLow`/`MergeHigh`,
//! `GallopLeft`/`GallopRight`, `min_gallop` starting at 7). This module is
//! that algorithm step for step, so the order is the engine's for every
//! comparator, consistent or not; `tests/data/js-sort-vectors.json`
//! (recorded from Node) holds it to V8.

use super::JsNumber;

/// `kMinGallopWins`, also `min_gallop`'s starting value.
const MIN_GALLOP: usize = 7;

/// The comparator as V8 calls it (`SortCompareUserFn`): the result's sign,
/// with `NaN` read as `+0`.
fn order<T>(items: &[T], compare: &mut impl FnMut(&T, &T) -> JsNumber, a: usize, b: usize) -> i8 {
    match compare(&items[a], &items[b]).compare(JsNumber::ZERO) {
        Some(std::cmp::Ordering::Less) => -1,
        Some(std::cmp::Ordering::Greater) => 1,
        _ => 0,
    }
}

/// `array.sort(compare)`: reorders `items` exactly as V8 would.
pub fn sort_by<T>(items: &mut Vec<T>, mut compare: impl FnMut(&T, &T) -> JsNumber) {
    let n = items.len();
    if n < 2 {
        return;
    }
    let mut state = State {
        work: (0..n).collect(),
        min_gallop: MIN_GALLOP,
        runs: Vec::new(),
    };
    {
        let mut cmp = |a: usize, b: usize| order(items, &mut compare, a, b);
        state.sort(&mut cmp);
    }
    let mut taken: Vec<Option<T>> = std::mem::take(items).into_iter().map(Some).collect();
    items.extend(
        state
            .work
            .iter()
            .filter_map(|&index| taken.get_mut(index).and_then(Option::take)),
    );
}

/// `ComputeMinRunLength(n)`.
const fn min_run_length(mut n: usize) -> usize {
    let mut r = 0;
    while n >= 64 {
        r |= n & 1;
        n >>= 1;
    }
    n + r
}

struct State {
    /// The array being sorted: indices into the caller's items.
    work: Vec<usize>,
    min_gallop: usize,
    /// Pending runs, `(base, length)`.
    runs: Vec<(usize, usize)>,
}

/// `GallopLeft(array, key, base, length, hint)`: the leftmost position in
/// `array[base..base + length]` where `key` belongs (`a[k - 1] < key <=
/// a[k]`), searched from `hint`.
fn gallop_left(
    cmp: &mut impl FnMut(usize, usize) -> i8,
    array: &[usize],
    key: usize,
    base: usize,
    length: usize,
    hint: usize,
) -> usize {
    let mut last_ofs: usize = 0;
    let mut offset: usize = 1;
    if cmp(array[base + hint], key) < 0 {
        // a[hint] < key: gallop right.
        let max_ofs = length - hint;
        while offset < max_ofs {
            if cmp(array[base + hint + offset], key) >= 0 {
                break;
            }
            last_ofs = offset;
            offset = (offset << 1) + 1;
        }
        offset = offset.min(max_ofs);
        return binary_left(cmp, array, key, base, last_ofs + hint + 1, offset + hint);
    }
    // key <= a[hint]: gallop left.
    let max_ofs = hint + 1;
    while offset < max_ofs {
        if cmp(array[base + hint - offset], key) < 0 {
            break;
        }
        last_ofs = offset;
        offset = (offset << 1) + 1;
    }
    offset = offset.min(max_ofs);
    // `lastOfs = hint - offset` may be -1: the `++` that follows is folded in.
    binary_left(cmp, array, key, base, hint + 1 - offset, hint - last_ofs)
}

/// The binary search that ends `GallopLeft`: `lo` is `lastOfs + 1`.
fn binary_left(
    cmp: &mut impl FnMut(usize, usize) -> i8,
    array: &[usize],
    key: usize,
    base: usize,
    mut lo: usize,
    mut hi: usize,
) -> usize {
    while lo < hi {
        let m = lo + ((hi - lo) >> 1);
        if cmp(array[base + m], key) < 0 {
            lo = m + 1;
        } else {
            hi = m;
        }
    }
    hi
}

/// `GallopRight(array, key, base, length, hint)`: the rightmost position in
/// `array[base..base + length]` where `key` belongs (`a[k - 1] <= key <
/// a[k]`), searched from `hint`.
fn gallop_right(
    cmp: &mut impl FnMut(usize, usize) -> i8,
    array: &[usize],
    key: usize,
    base: usize,
    length: usize,
    hint: usize,
) -> usize {
    let mut last_ofs: usize = 0;
    let mut offset: usize = 1;
    if cmp(key, array[base + hint]) < 0 {
        // key < a[hint]: gallop left.
        let max_ofs = hint + 1;
        while offset < max_ofs {
            if cmp(key, array[base + hint - offset]) >= 0 {
                break;
            }
            last_ofs = offset;
            offset = (offset << 1) + 1;
        }
        offset = offset.min(max_ofs);
        // `lastOfs = hint - offset` (maybe -1), then `++`.
        let lo = hint + 1 - offset;
        let hi = hint - last_ofs;
        return binary_right(cmp, array, key, base, lo, hi);
    }
    // a[hint] <= key: gallop right.
    let max_ofs = length - hint;
    while offset < max_ofs {
        if cmp(key, array[base + hint + offset]) < 0 {
            break;
        }
        last_ofs = offset;
        offset = (offset << 1) + 1;
    }
    offset = offset.min(max_ofs);
    binary_right(cmp, array, key, base, last_ofs + hint + 1, offset + hint)
}

/// The binary search that ends `GallopRight`.
fn binary_right(
    cmp: &mut impl FnMut(usize, usize) -> i8,
    array: &[usize],
    key: usize,
    base: usize,
    mut lo: usize,
    mut hi: usize,
) -> usize {
    while lo < hi {
        let m = lo + ((hi - lo) >> 1);
        if cmp(key, array[base + m]) < 0 {
            hi = m;
        } else {
            lo = m + 1;
        }
    }
    hi
}

impl State {
    /// `ArrayTimSortImpl`.
    fn sort(&mut self, cmp: &mut impl FnMut(usize, usize) -> i8) {
        let length = self.work.len();
        let mut remaining = length;
        let mut low = 0;
        let min_run = min_run_length(remaining);
        while remaining != 0 {
            let mut run = self.count_and_make_run(cmp, low, low + remaining);
            if run < min_run {
                let forced = min_run.min(remaining);
                self.binary_insertion_sort(cmp, low, low + run, low + forced);
                run = forced;
            }
            self.runs.push((low, run));
            self.merge_collapse(cmp);
            low += run;
            remaining -= run;
        }
        self.merge_force_collapse(cmp);
    }

    /// `CountAndMakeRun(low, high)`: the length of the run at `low`; a
    /// strictly descending run is reversed in place.
    fn count_and_make_run(
        &mut self,
        cmp: &mut impl FnMut(usize, usize) -> i8,
        low_arg: usize,
        high: usize,
    ) -> usize {
        let low = low_arg + 1;
        if low == high {
            return 1;
        }
        let mut run = 2;
        let descending = cmp(self.work[low], self.work[low - 1]) < 0;
        let mut previous = self.work[low];
        for idx in low + 1..high {
            let current = self.work[idx];
            let order = cmp(current, previous);
            if descending {
                if order >= 0 {
                    break;
                }
            } else if order < 0 {
                break;
            }
            previous = current;
            run += 1;
        }
        if descending {
            self.work[low_arg..low_arg + run].reverse();
        }
        run
    }

    /// `BinaryInsertionSort(low, start, high)`: `work[low..start]` is
    /// sorted; insert the rest.
    fn binary_insertion_sort(
        &mut self,
        cmp: &mut impl FnMut(usize, usize) -> i8,
        low: usize,
        start_arg: usize,
        high: usize,
    ) {
        let mut start = if low == start_arg {
            start_arg + 1
        } else {
            start_arg
        };
        while start < high {
            let mut left = low;
            let mut right = start;
            let pivot = self.work[start];
            while left < right {
                let mid = left + ((right - left) >> 1);
                if cmp(pivot, self.work[mid]) < 0 {
                    right = mid;
                } else {
                    left = mid + 1;
                }
            }
            self.work.copy_within(left..start, left + 1);
            self.work[left] = pivot;
            start += 1;
        }
    }

    /// `RunInvariantEstablished(runs, n)`.
    fn invariant(&self, n: usize) -> bool {
        if n < 2 {
            return true;
        }
        self.runs[n - 2].1 > self.runs[n - 1].1 + self.runs[n].1
    }

    /// `MergeCollapse`.
    fn merge_collapse(&mut self, cmp: &mut impl FnMut(usize, usize) -> i8) {
        while self.runs.len() > 1 {
            let mut n = self.runs.len() - 2;
            if !self.invariant(n + 1) || !self.invariant(n) {
                if self.runs[n - 1].1 < self.runs[n + 1].1 {
                    n -= 1;
                }
                self.merge_at(cmp, n);
            } else if self.runs[n].1 <= self.runs[n + 1].1 {
                self.merge_at(cmp, n);
            } else {
                break;
            }
        }
    }

    /// `MergeForceCollapse`.
    fn merge_force_collapse(&mut self, cmp: &mut impl FnMut(usize, usize) -> i8) {
        while self.runs.len() > 1 {
            let mut n = self.runs.len() - 2;
            if n > 0 && self.runs[n - 1].1 < self.runs[n + 1].1 {
                n -= 1;
            }
            self.merge_at(cmp, n);
        }
    }

    /// `MergeAt(i)`: merges runs `i` and `i + 1`.
    fn merge_at(&mut self, cmp: &mut impl FnMut(usize, usize) -> i8, i: usize) {
        let (mut base_a, mut length_a) = self.runs[i];
        let (base_b, mut length_b) = self.runs[i + 1];
        self.runs[i].1 = length_a + length_b;
        self.runs.remove(i + 1);

        // Where does b start in a? Elements of a before that stay put.
        let key_right = self.work[base_b];
        let k = gallop_right(cmp, &self.work, key_right, base_a, length_a, 0);
        base_a += k;
        length_a -= k;
        if length_a == 0 {
            return;
        }
        // Where does a end in b? Elements of b after that stay put.
        let key_left = self.work[base_a + length_a - 1];
        length_b = gallop_left(cmp, &self.work, key_left, base_b, length_b, length_b - 1);
        if length_b == 0 {
            return;
        }
        if length_a <= length_b {
            self.merge_low(cmp, base_a, length_a, base_b, length_b);
        } else {
            self.merge_high(cmp, base_a, length_a, base_b, length_b);
        }
    }

    /// `MergeLow`: run a is the shorter; it is copied out and the merge
    /// runs forward.
    #[allow(clippy::too_many_lines)]
    fn merge_low(
        &mut self,
        cmp: &mut impl FnMut(usize, usize) -> i8,
        base_a: usize,
        mut length_a: usize,
        base_b: usize,
        mut length_b: usize,
    ) {
        let temp: Vec<usize> = self.work[base_a..base_a + length_a].to_vec();
        let mut dest = base_a;
        let mut cursor_temp = 0;
        let mut cursor_b = base_b;
        self.work[dest] = self.work[cursor_b];
        dest += 1;
        cursor_b += 1;

        enum Exit {
            Succeed,
            CopyB,
        }
        let exit = 'merge: {
            length_b -= 1;
            if length_b == 0 {
                break 'merge Exit::Succeed;
            }
            if length_a == 1 {
                break 'merge Exit::CopyB;
            }
            let mut min_gallop = self.min_gallop;
            loop {
                let mut wins_a: usize = 0;
                let mut wins_b: usize = 0;
                loop {
                    if cmp(self.work[cursor_b], temp[cursor_temp]) < 0 {
                        self.work[dest] = self.work[cursor_b];
                        dest += 1;
                        cursor_b += 1;
                        wins_b += 1;
                        length_b -= 1;
                        wins_a = 0;
                        if length_b == 0 {
                            break 'merge Exit::Succeed;
                        }
                        if wins_b >= min_gallop {
                            break;
                        }
                    } else {
                        self.work[dest] = temp[cursor_temp];
                        dest += 1;
                        cursor_temp += 1;
                        wins_a += 1;
                        length_a -= 1;
                        wins_b = 0;
                        if length_a == 1 {
                            break 'merge Exit::CopyB;
                        }
                        if wins_a >= min_gallop {
                            break;
                        }
                    }
                }
                min_gallop += 1;
                let mut first = true;
                while wins_a >= MIN_GALLOP || wins_b >= MIN_GALLOP || first {
                    first = false;
                    min_gallop = min_gallop.saturating_sub(1).max(1);
                    self.min_gallop = min_gallop;
                    wins_a =
                        gallop_right(cmp, &temp, self.work[cursor_b], cursor_temp, length_a, 0);
                    if wins_a > 0 {
                        self.work[dest..dest + wins_a]
                            .copy_from_slice(&temp[cursor_temp..cursor_temp + wins_a]);
                        dest += wins_a;
                        cursor_temp += wins_a;
                        length_a -= wins_a;
                        if length_a == 1 {
                            break 'merge Exit::CopyB;
                        }
                        // Impossible for a consistent comparator; possible here.
                        if length_a == 0 {
                            break 'merge Exit::Succeed;
                        }
                    }
                    self.work[dest] = self.work[cursor_b];
                    dest += 1;
                    cursor_b += 1;
                    length_b -= 1;
                    if length_b == 0 {
                        break 'merge Exit::Succeed;
                    }
                    wins_b = gallop_left(cmp, &self.work, temp[cursor_temp], cursor_b, length_b, 0);
                    if wins_b > 0 {
                        self.work.copy_within(cursor_b..cursor_b + wins_b, dest);
                        dest += wins_b;
                        cursor_b += wins_b;
                        length_b -= wins_b;
                        if length_b == 0 {
                            break 'merge Exit::Succeed;
                        }
                    }
                    self.work[dest] = temp[cursor_temp];
                    dest += 1;
                    cursor_temp += 1;
                    length_a -= 1;
                    if length_a == 1 {
                        break 'merge Exit::CopyB;
                    }
                }
                min_gallop += 1;
                self.min_gallop = min_gallop;
            }
        };
        match exit {
            Exit::Succeed => {
                if length_a > 0 {
                    self.work[dest..dest + length_a]
                        .copy_from_slice(&temp[cursor_temp..cursor_temp + length_a]);
                }
            }
            Exit::CopyB => {
                // The last element of run a belongs at the end of the merge.
                self.work.copy_within(cursor_b..cursor_b + length_b, dest);
                self.work[dest + length_b] = temp[cursor_temp];
            }
        }
    }

    /// `MergeHigh`: run b is the shorter; it is copied out and the merge
    /// runs backward. Cursors are kept one past their TypeScript value (a
    /// `-1` there is `0` here).
    #[allow(clippy::too_many_lines)]
    fn merge_high(
        &mut self,
        cmp: &mut impl FnMut(usize, usize) -> i8,
        base_a: usize,
        mut length_a: usize,
        base_b: usize,
        mut length_b: usize,
    ) {
        let temp: Vec<usize> = self.work[base_b..base_b + length_b].to_vec();
        // `dest`, `cursorTemp` and `cursorA` of V8, each plus one.
        let mut dest = base_b + length_b;
        let mut cursor_temp = length_b;
        let mut cursor_a = base_a + length_a;
        self.work[dest - 1] = self.work[cursor_a - 1];
        dest -= 1;
        cursor_a -= 1;

        enum Exit {
            Succeed,
            CopyA,
        }
        let exit = 'merge: {
            length_a -= 1;
            if length_a == 0 {
                break 'merge Exit::Succeed;
            }
            if length_b == 1 {
                break 'merge Exit::CopyA;
            }
            let mut min_gallop = self.min_gallop;
            loop {
                let mut wins_a: usize = 0;
                let mut wins_b: usize = 0;
                loop {
                    if cmp(temp[cursor_temp - 1], self.work[cursor_a - 1]) < 0 {
                        self.work[dest - 1] = self.work[cursor_a - 1];
                        dest -= 1;
                        cursor_a -= 1;
                        wins_a += 1;
                        length_a -= 1;
                        wins_b = 0;
                        if length_a == 0 {
                            break 'merge Exit::Succeed;
                        }
                        if wins_a >= min_gallop {
                            break;
                        }
                    } else {
                        self.work[dest - 1] = temp[cursor_temp - 1];
                        dest -= 1;
                        cursor_temp -= 1;
                        wins_b += 1;
                        length_b -= 1;
                        wins_a = 0;
                        if length_b == 1 {
                            break 'merge Exit::CopyA;
                        }
                        if wins_b >= min_gallop {
                            break;
                        }
                    }
                }
                min_gallop += 1;
                let mut first = true;
                while wins_a >= MIN_GALLOP || wins_b >= MIN_GALLOP || first {
                    first = false;
                    min_gallop = min_gallop.saturating_sub(1).max(1);
                    self.min_gallop = min_gallop;
                    let k = gallop_right(
                        cmp,
                        &self.work,
                        temp[cursor_temp - 1],
                        base_a,
                        length_a,
                        length_a - 1,
                    );
                    wins_a = length_a - k;
                    if wins_a > 0 {
                        dest -= wins_a;
                        cursor_a -= wins_a;
                        self.work.copy_within(cursor_a..cursor_a + wins_a, dest);
                        length_a -= wins_a;
                        if length_a == 0 {
                            break 'merge Exit::Succeed;
                        }
                    }
                    self.work[dest - 1] = temp[cursor_temp - 1];
                    dest -= 1;
                    cursor_temp -= 1;
                    length_b -= 1;
                    if length_b == 1 {
                        break 'merge Exit::CopyA;
                    }
                    let k = gallop_left(
                        cmp,
                        &temp,
                        self.work[cursor_a - 1],
                        0,
                        length_b,
                        length_b - 1,
                    );
                    wins_b = length_b - k;
                    if wins_b > 0 {
                        dest -= wins_b;
                        cursor_temp -= wins_b;
                        self.work[dest..dest + wins_b]
                            .copy_from_slice(&temp[cursor_temp..cursor_temp + wins_b]);
                        length_b -= wins_b;
                        if length_b == 1 {
                            break 'merge Exit::CopyA;
                        }
                        // Impossible for a consistent comparator; possible here.
                        if length_b == 0 {
                            break 'merge Exit::Succeed;
                        }
                    }
                    self.work[dest - 1] = self.work[cursor_a - 1];
                    dest -= 1;
                    cursor_a -= 1;
                    length_a -= 1;
                    if length_a == 0 {
                        break 'merge Exit::Succeed;
                    }
                }
                min_gallop += 1;
                self.min_gallop = min_gallop;
            }
        };
        match exit {
            Exit::Succeed => {
                if length_b > 0 {
                    // V8: `Copy(tempArray, 0, workArray, dest - (lengthB - 1), lengthB)`.
                    self.work[dest - length_b..dest].copy_from_slice(&temp[..length_b]);
                }
            }
            Exit::CopyA => {
                // The first element of run b belongs at the front of the merge.
                dest -= length_a;
                cursor_a -= length_a;
                self.work.copy_within(cursor_a..cursor_a + length_a, dest);
                self.work[dest - 1] = temp[cursor_temp - 1];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(value: i64) -> JsNumber {
        JsNumber::from_i64(value)
    }

    #[test]
    fn a_consistent_comparator_is_a_stable_sort() {
        let mut items: Vec<(i64, usize)> = (0..500)
            .map(|i| ((i * 7919 + 13) % 37, usize::try_from(i).expect("small")))
            .collect();
        let mut expected = items.clone();
        expected.sort_by_key(|item| item.0);
        sort_by(&mut items, |a, b| n(a.0) - n(b.0));
        assert_eq!(items, expected);
    }

    /// Every case of `tests/data/js-sort-vectors.json`, recorded from Node:
    /// `NaN` (an inconsistent comparator), `±Infinity`, sizes past the
    /// 64 where runs start being merged.
    #[test]
    fn orders_as_v8_does() {
        let vectors: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/data/js-sort-vectors.json"))
                .expect("js-sort-vectors.json");
        let cases = vectors["cases"].as_array().expect("cases");
        let mut problems = Vec::new();
        let mut unlike_stable = 0;
        for (k, case) in cases.iter().enumerate() {
            let values: Vec<(JsNumber, u64)> = case["values"]
                .as_array()
                .expect("values")
                .iter()
                .zip(0_u64..)
                .map(|(value, i)| {
                    let number = match value {
                        serde_json::Value::String(text) => JsNumber::parse(text),
                        other => JsNumber::parse(&other.to_string()),
                    };
                    (number, i)
                })
                .collect();
            let descending = case["descending"].as_bool().expect("descending");
            let mut items = values;
            sort_by(
                &mut items,
                |a, b| {
                    if descending { b.0 - a.0 } else { a.0 - b.0 }
                },
            );
            let order: Vec<u64> = items.iter().map(|item| item.1).collect();
            let expected: Vec<u64> = case["order"]
                .as_array()
                .expect("order")
                .iter()
                .map(|i| i.as_u64().expect("index"))
                .collect();
            if order != expected {
                problems.push(k);
            }
            // The cases have teeth: a plain stable insertion sort, reading
            // `NaN` as a tie, gets many of them wrong. (Rust's own `sort_by`
            // may panic on such a comparator.)
            let mut stable = items.clone();
            stable.sort_by_key(|item| item.1);
            for i in 1..stable.len() {
                let mut j = i;
                while j > 0 {
                    let (a, b) = (stable[j - 1].0, stable[j].0);
                    let difference = if descending { b - a } else { a - b };
                    if difference.greater_than(JsNumber::ZERO) {
                        stable.swap(j - 1, j);
                        j -= 1;
                    } else {
                        break;
                    }
                }
            }
            if stable.iter().map(|item| item.1).collect::<Vec<_>>() != expected {
                unlike_stable += 1;
            }
        }
        assert!(cases.len() > 1000);
        assert!(unlike_stable > 100, "{unlike_stable}");
        assert!(problems.is_empty(), "cases {problems:?} differ");
    }

    #[test]
    fn short_arrays() {
        let mut empty: Vec<i64> = Vec::new();
        sort_by(&mut empty, |a, b| n(*a) - n(*b));
        assert!(empty.is_empty());
        let mut one = vec![5];
        sort_by(&mut one, |a, b| n(*a) - n(*b));
        assert_eq!(one, [5]);
    }
}
