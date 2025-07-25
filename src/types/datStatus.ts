import { writeToString } from '@fast-csv/format';
import type { ChalkInstance } from 'chalk';
import chalk from 'chalk';

import ArrayPoly from '../polyfill/arrayPoly.js';
import type DAT from './dats/dat.js';
import type Game from './dats/game.js';
import type File from './files/file.js';
import type Options from './options.js';
import type WriteCandidate from './writeCandidate.js';

const ROMType = {
  GAME: 'games',
  BIOS: 'BIOSes',
  DEVICE: 'devices',
  RETAIL: 'retail releases',
  PATCHED: 'patched games',
} as const;
type ROMTypeValue = (typeof ROMType)[keyof typeof ROMType];

export const GameStatus = {
  // The Game wanted to be written, and it has no ROMs or every ROM was found
  FOUND: 1,
  // Only some of the Game's ROMs were found
  INCOMPLETE: 2,
  // The Game wanted to be written, but there was no matching ReleaseCandidate
  MISSING: 3,
  // The input file was not used in any ReleaseCandidate, but a duplicate file was
  DUPLICATE: 4,
  // The input File was not used in any ReleaseCandidate, and neither was any duplicate file
  UNUSED: 5,
  // The output File was not from any ReleaseCandidate, so it was deleted
  DELETED: 6,
} as const;
type GameStatusKey = keyof typeof GameStatus;
export type GameStatusValue = (typeof GameStatus)[GameStatusKey];
const GameStatusInverted = Object.fromEntries(
  Object.entries(GameStatus).map(([key, value]) => [value, key]),
) as Record<GameStatusValue, GameStatusKey>;

/**
 * Parse and hold information about every {@link Game} in a {@link DAT}, as well as which
 * {@link Game}s were found (had a {@link WriteCandidate} created for it).
 */
export default class DATStatus {
  private readonly dat: DAT;

  private readonly allRomTypesToGames = new Map<ROMTypeValue, Game[]>();

  private readonly foundRomTypesToCandidates = new Map<
    ROMTypeValue,
    (WriteCandidate | undefined)[]
  >();

  private readonly incompleteRomTypesToCandidates = new Map<ROMTypeValue, WriteCandidate[]>();

  constructor(dat: DAT, candidates: WriteCandidate[]) {
    this.dat = dat;

    const indexedCandidates = candidates.reduce((map, candidate) => {
      const key = candidate.getGame().hashCode();
      if (map.has(key)) {
        map.get(key)?.push(candidate);
      } else {
        map.set(key, [candidate]);
      }
      return map;
    }, new Map<string, WriteCandidate[]>());

    // Un-patched ROMs
    dat.getGames().forEach((game: Game) => {
      DATStatus.pushValueIntoMap(this.allRomTypesToGames, game, game);

      const gameCandidates = indexedCandidates.get(game.hashCode());
      if (gameCandidates !== undefined || game.getRoms().length === 0) {
        const gameCandidate = gameCandidates?.at(0);

        if (gameCandidate && gameCandidate.getRomsWithFiles().length !== game.getRoms().length) {
          // The found ReleaseCandidate is incomplete
          DATStatus.pushValueIntoMap(this.incompleteRomTypesToCandidates, game, gameCandidate);
          return;
        }

        // The found ReleaseCandidate is complete
        DATStatus.pushValueIntoMap(this.foundRomTypesToCandidates, game, gameCandidate);
        return;
      }
    });

    // Patched ROMs
    for (const candidate of candidates.filter((candidate) => candidate.isPatched())) {
      const game = candidate.getGame();
      DATStatus.append(this.allRomTypesToGames, ROMType.PATCHED, game);
      DATStatus.append(this.foundRomTypesToCandidates, ROMType.PATCHED, candidate);
    }
  }

  private static pushValueIntoMap<T>(map: Map<ROMTypeValue, T[]>, game: Game, value: T): void {
    DATStatus.append(map, ROMType.GAME, value);
    if (game.getIsBios()) {
      DATStatus.append(map, ROMType.BIOS, value);
    }
    if (game.getIsDevice()) {
      DATStatus.append(map, ROMType.DEVICE, value);
    }
    if (game.isRetail()) {
      DATStatus.append(map, ROMType.RETAIL, value);
    }
  }

  private static append<T>(map: Map<ROMTypeValue, T[]>, romType: ROMTypeValue, value: T): void {
    if (map.has(romType)) {
      map.get(romType)?.push(value);
    } else {
      map.set(romType, [value]);
    }
  }

  getDATName(): string {
    return this.dat.getName();
  }

  getInputFiles(): File[] {
    return [
      ...this.foundRomTypesToCandidates.values(),
      ...this.incompleteRomTypesToCandidates.values(),
    ]
      .flat()
      .filter((candidate) => candidate !== undefined)
      .flatMap((candidate) => candidate.getRomsWithFiles())
      .map((romWithFiles) => romWithFiles.getInputFile());
  }

  /**
   * If any {@link Game} in the entire {@link DAT} was found in the input files.
   */
  anyGamesFound(options: Options): boolean {
    return DATStatus.getAllowedTypes(options).reduce((result, romType) => {
      const foundCandidates = this.foundRomTypesToCandidates.get(romType)?.length ?? 0;
      return result || foundCandidates > 0;
    }, false);
  }

  /**
   * Return a string of CLI-friendly output to be printed by a {@link Logger}.
   */
  toConsole(options: Options): string {
    return `${DATStatus.getAllowedTypes(options)
      .filter((type) => {
        const games = this.allRomTypesToGames.get(type);
        return games !== undefined && games.length > 0;
      })
      .map((type) => {
        const found = this.foundRomTypesToCandidates.get(type) ?? [];
        const all = this.allRomTypesToGames.get(type) ?? [];

        if (!options.usingDats()) {
          return `${found.length.toLocaleString()} ${type}`;
        }

        const percentage = (found.length / all.length) * 100;
        let color: ChalkInstance;
        if (percentage >= 100) {
          color = chalk.rgb(0, 166, 0); // macOS terminal green
        } else if (percentage >= 75) {
          color = chalk.rgb(153, 153, 0); // macOS terminal yellow
        } else if (percentage >= 50) {
          color = chalk.rgb(160, 124, 0);
        } else if (percentage >= 25) {
          color = chalk.rgb(162, 93, 0);
        } else if (percentage > 0) {
          color = chalk.rgb(160, 59, 0);
        } else {
          color = chalk.rgb(153, 0, 0); // macOS terminal red
        }

        // Patched ROMs are always found===all
        if (type === ROMType.PATCHED) {
          return `${color(all.length.toLocaleString())} ${type}`;
        }

        return `${color(found.length.toLocaleString())}/${all.length.toLocaleString()} ${type}`;
      })
      .filter((string_) => string_.length > 0)
      .join(', ')} ${options.shouldWrite() ? 'written' : 'found'}`;
  }

  /**
   * Return the file contents of a CSV with status information for every {@link Game}.
   */
  async toCsv(options: Options): Promise<string> {
    const foundCandidates = DATStatus.getValuesForAllowedTypes(
      options,
      this.foundRomTypesToCandidates,
    );

    const incompleteCandidates = DATStatus.getValuesForAllowedTypes(
      options,
      this.incompleteRomTypesToCandidates,
    );

    const rows = DATStatus.getValuesForAllowedTypes(options, this.allRomTypesToGames)
      .reduce(ArrayPoly.reduceUnique(), [])
      .sort((a, b) => a.getName().localeCompare(b.getName()))
      .map((game) => {
        let status: GameStatusValue = GameStatus.MISSING;

        const incompleteCandidate = incompleteCandidates.find((candidate) =>
          candidate.getGame().equals(game),
        );
        if (incompleteCandidate) {
          status = GameStatus.INCOMPLETE;
        }

        const foundCandidate = foundCandidates.find((candidate) =>
          candidate?.getGame().equals(game),
        );
        if (foundCandidate !== undefined || game.getRoms().length === 0) {
          status = GameStatus.FOUND;
        }

        const filePaths = [
          ...(incompleteCandidate ? incompleteCandidate.getRomsWithFiles() : []),
          ...(foundCandidate ? foundCandidate.getRomsWithFiles() : []),
        ]
          .map((romWithFiles) =>
            options.shouldWrite() ? romWithFiles.getOutputFile() : romWithFiles.getInputFile(),
          )
          .map((file) => file.getFilePath())
          .reduce(ArrayPoly.reduceUnique(), []);

        return DATStatus.buildCsvRow(
          this.getDATName(),
          game.getName(),
          status,
          filePaths,
          foundCandidate?.isPatched() ?? false,
          game.getIsBios(),
          game.isRetail(),
          game.isUnlicensed(),
          game.isDebug(),
          game.isDemo(),
          game.isBeta(),
          game.isSample(),
          game.isPrototype(),
          game.isProgram(),
          game.isAftermarket(),
          game.isHomebrew(),
          game.isBad(),
        );
      });
    return writeToString(rows, {
      headers: [
        'DAT Name',
        'Game Name',
        'Status',
        'ROM Files',
        'Patched',
        'BIOS',
        'Retail Release',
        'Unlicensed',
        'Debug',
        'Demo',
        'Beta',
        'Sample',
        'Prototype',
        'Program',
        'Aftermarket',
        'Homebrew',
        'Bad',
      ],
    });
  }

  /**
   * Return a string of CSV rows without headers for a certain {@link GameStatusValue}.
   */
  static async filesToCsv(filePaths: string[], status: GameStatusValue): Promise<string> {
    return writeToString(filePaths.map((filePath) => this.buildCsvRow('', '', status, [filePath])));
  }

  private static buildCsvRow(
    datName: string,
    gameName: string,
    status: GameStatusValue,
    filePaths: string[] = [],
    patched = false,
    bios = false,
    retail = false,
    unlicensed = false,
    debug = false,
    demo = false,
    beta = false,
    sample = false,
    prototype = false,
    test = false,
    aftermarket = false,
    homebrew = false,
    bad = false,
  ): string[] {
    return [
      datName,
      gameName,
      GameStatusInverted[status],
      filePaths.join('|'),
      String(patched),
      String(bios),
      String(retail),
      String(unlicensed),
      String(debug),
      String(demo),
      String(beta),
      String(sample),
      String(prototype),
      String(test),
      String(aftermarket),
      String(homebrew),
      String(bad),
    ];
  }

  private static getValuesForAllowedTypes<T>(
    options: Options,
    romTypesToValues: Map<ROMTypeValue, T[]>,
  ): T[] {
    return DATStatus.getAllowedTypes(options)
      .flatMap((type) => romTypesToValues.get(type))
      .filter((value) => value !== undefined)
      .reduce(ArrayPoly.reduceUnique(), [])
      .sort();
  }

  private static getAllowedTypes(options: Options): ROMTypeValue[] {
    return [
      !options.getOnlyBios() && !options.getOnlyDevice() && !options.getOnlyRetail()
        ? ROMType.GAME
        : undefined,
      options.getOnlyBios() || (!options.getNoBios() && !options.getOnlyDevice())
        ? ROMType.BIOS
        : undefined,
      options.getOnlyDevice() || (!options.getOnlyBios() && !options.getNoDevice())
        ? ROMType.DEVICE
        : undefined,
      options.getOnlyRetail() || (!options.getOnlyBios() && !options.getOnlyDevice())
        ? ROMType.RETAIL
        : undefined,
      ROMType.PATCHED,
    ].filter((romType) => romType !== undefined);
  }
}
