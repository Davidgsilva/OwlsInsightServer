#!/usr/bin/env node

/**
 * Coverage Report Script
 * Generates a formatted report showing which sportsbooks are providing
 * odds and props data across all sports.
 *
 * Usage:
 *   node scripts/coverage-report.js
 *   SERVER_URL=https://ws.owlsinsight.com node scripts/coverage-report.js
 */

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3002';

const ALL_ODDS_BOOKS = ['pinnacle', 'fanduel', 'draftkings', 'betmgm', 'bet365', 'caesars'];
const ALL_PROPS_BOOKS = ['pinnacle', 'bet365', 'fanduel', 'draftkings'];
const SPORTS = ['nba', 'ncaab', 'nfl', 'nhl', 'ncaaf'];

async function main() {
  console.log(`Fetching coverage data from ${SERVER_URL}...`);

  const resp = await fetch(`${SERVER_URL}/api/v1/coverage`);
  if (!resp.ok) {
    console.error(`Failed to fetch coverage: ${resp.status} ${resp.statusText}`);
    process.exit(1);
  }

  const data = await resp.json();

  if (!data.success) {
    console.error('Coverage endpoint returned error:', data);
    process.exit(1);
  }

  printReport(data);
}

function printReport(data) {
  const LINE = '='.repeat(80);
  const today = new Date().toISOString().split('T')[0];

  // Header
  console.log('\n' + LINE);
  console.log(`                         COVERAGE REPORT - ${today}`);
  console.log(LINE);

  // Summary
  console.log('\nSUMMARY');
  console.log('-'.repeat(7));
  console.log(`Total Games: ${data.summary.totalGames}`);
  console.log(`Total Props: ${data.summary.totalProps}`);
  console.log(`Odds Books:  ${data.summary.oddsBooks}/${ALL_ODDS_BOOKS.length}`);
  console.log(`Props Books: ${data.summary.propsBooks}/${ALL_PROPS_BOOKS.length}`);

  // Odds coverage
  console.log('\n' + LINE);
  console.log('                              ODDS COVERAGE');
  console.log(LINE);

  SPORTS.forEach(sport => {
    const sportData = data.odds[sport] || { games: 0, books: {} };
    console.log(`\n${sport.toUpperCase()} (${sportData.games} games)`);
    console.log('-'.repeat(14));
    console.log('Book         | Games | h2h | spreads | totals');
    console.log('-------------|-------|-----|---------|-------');

    ALL_ODDS_BOOKS.forEach(book => {
      const bookData = sportData.books[book] || { games: 0, markets: [] };
      const hasH2h = bookData.markets.includes('h2h') ? '✓' : '-';
      const hasSpreads = bookData.markets.includes('spreads') ? '✓' : '-';
      const hasTotals = bookData.markets.includes('totals') ? '✓' : '-';
      console.log(`${book.padEnd(12)} | ${String(bookData.games).padStart(5)} |  ${hasH2h}  |    ${hasSpreads}    |   ${hasTotals}`);
    });
  });

  // Props coverage
  console.log('\n' + LINE);
  console.log('                              PROPS COVERAGE');
  console.log(LINE);

  SPORTS.forEach(sport => {
    const sportData = data.props[sport] || {};
    console.log(`\n${sport.toUpperCase()}`);
    console.log('-'.repeat(sport.length));
    console.log('Book         | Games | Props');
    console.log('-------------|-------|------');

    ALL_PROPS_BOOKS.forEach(book => {
      const bookData = sportData[book] || { games: 0, props: 0 };
      console.log(`${book.padEnd(12)} | ${String(bookData.games).padStart(5)} | ${String(bookData.props).padStart(5)}`);
    });
  });

  console.log('\n' + LINE);
  console.log(`Report generated at: ${new Date().toISOString()}`);
  console.log(LINE + '\n');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
