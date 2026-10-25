// hum-ideas-dow-valid.test.mjs — dowValid checks the weekday against the date
// the idea MEANS.
//
// An earlier version scanned from 31 days before the idea's window and took the
// first day-of-month that matched, ignoring the month the text named, so
// "Sat Jan 16" was checked against Wed Dec 16 and "Tue Jan 19" against Sat Dec
// 19 — and correct ideas were expired as "stated weekday does not match the
// date". A genuinely wrong weekday must still fail.
// Run: node --test tests/hum-ideas-dow-valid.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { dowValid } from "../agent/scripts/hum-harvesters/ideas.mjs";

const idea = (subject, until, rationale = "") => ({ subject, rationale, time_sensitive_until: until });

test("a right weekday with a named month passes, whatever falls a month earlier", () => {
  assert.equal(dowValid(idea("Book club, Sat Jan 16, 1-3pm", "2027-01-15T12:00:00Z")), true);
  assert.equal(dowValid(idea("Window cleaning visit", "2027-01-19T10:00:00Z", "on Tue Jan 19 (10am-1pm)")), true);
  assert.equal(dowValid(idea("Open mic night, Thu Jan 14 9pm", "2027-01-14T21:00:00Z")), true);
  assert.equal(dowValid(idea("Sat Jan 2 the market is closed; Sun Jan 3 it reopens", "2027-01-02T20:00:00Z")), true);
});

test("a wrong weekday still fails ('Sat Jun 27' when Jun 27 is a Sunday)", () => {
  assert.equal(dowValid(idea("Sat Jun 27 is the gallery's last late opening", "2027-06-27T20:00:00Z")), false);
  assert.equal(dowValid(idea("Fri Jan 16 book club", "2027-01-16T13:00:00Z")), false);
  assert.equal(dowValid(idea("Weekend stack", "2027-09-18T20:00:00Z", "both landing Saturday Sep 19")), false);
});

test("the named month is taken in the year nearest the window", () => {
  assert.equal(dowValid(idea("New Year call Sat Jan 1", "2027-12-30T12:00:00Z")), true);
  assert.equal(dowValid(idea("New Year call Fri Jan 1", "2027-12-30T12:00:00Z")), false);
});

test("no month named: the nearest matching day-of-month, and no date at all passes", () => {
  assert.equal(dowValid(idea("Dinner Saturday the 16", "2027-01-16T20:00:00Z")), true);
  assert.equal(dowValid(idea("Dinner Friday the 16", "2027-01-16T20:00:00Z")), false);
  assert.equal(dowValid(idea("Free evening tonight", "2027-01-07T22:00:00Z")), true);
});
