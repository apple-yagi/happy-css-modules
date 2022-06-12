'use strict';

import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import { DtsCreator } from '../src/dts-creator';

describe('DtsCreator', () => {
  const creator = new DtsCreator();

  describe('#create', () => {
    it('returns DtsContent instance simple css', (done) => {
      void creator.create('test/testStyle.css').then((content) => {
        assert.equal(content.contents.length, 1);
        assert.equal(content.contents[0], 'readonly "myClass": string;');
        done();
      });
    });
    it('rejects an error with invalid CSS', (done) => {
      creator
        .create('test/errorCss.css')
        .then((content) => {
          assert.fail();
        })
        .catch((err) => {
          assert.equal(err.name, 'CssSyntaxError');
          done();
        });
    });
    it('returns DtsContent instance from composing css', (done) => {
      void creator.create('test/composer.css').then((content) => {
        assert.equal(content.contents.length, 1);
        assert.equal(content.contents[0], 'readonly "root": string;');
        done();
      });
    });
    it('returns DtsContent instance from composing css whose has invalid import/composes', (done) => {
      void creator.create('test/invalidComposer.scss').then((content) => {
        assert.equal(content.contents.length, 1);
        assert.equal(content.contents[0], 'readonly "myClass": string;');
        done();
      });
    });
    it('returns DtsContent instance from the pair of path and contents', (done) => {
      void creator
        .create('test/somePath', async () => Promise.resolve(`.myClass { color: red }`))
        .then((content) => {
          assert.equal(content.contents.length, 1);
          assert.equal(content.contents[0], 'readonly "myClass": string;');
          done();
        });
    });
    it('returns DtsContent instance combined css', (done) => {
      void creator.create('test/combined/combined.css').then((content) => {
        assert.equal(content.contents.length, 3);
        assert.equal(content.contents[0], 'readonly "block": string;');
        assert.equal(content.contents[1], 'readonly "myClass": string;');
        assert.equal(content.contents[2], 'readonly "box": string;');
        done();
      });
    });
  });

  describe('#modify path', () => {
    it('can be set outDir', (done) => {
      void new DtsCreator({ searchDir: 'test', outDir: 'dist' })
        .create(path.normalize('test/testStyle.css'))
        .then((content) => {
          assert.equal(path.relative(process.cwd(), content.outputFilePath), path.normalize('dist/testStyle.css.d.ts'));
          done();
        });
    });
  });
});

describe('DtsContent', () => {
  describe('#tokens', () => {
    it('returns original tokens', (done) => {
      void new DtsCreator().create('test/testStyle.css').then((content) => {
        assert.deepStrictEqual(content.tokens[0], {
          name: 'myClass',
          originalPositions: [
            {
              column: 0,
              filePath: '/Users/mizdra/src/github.com/mizdra/checkable-css-modules/test/testStyle.css',
              line: 1,
            },
          ],
        });
        done();
      });
    });
  });

  describe('#inputFilePath', () => {
    it('returns original CSS file name', (done) => {
      void new DtsCreator().create(path.normalize('test/testStyle.css')).then((content) => {
        assert.equal(path.relative(process.cwd(), content.inputFilePath), path.normalize('test/testStyle.css'));
        done();
      });
    });
  });

  describe('#outputFilePath', () => {
    it('adds d.ts to the original filename', (done) => {
      void new DtsCreator().create(path.normalize('test/testStyle.css')).then((content) => {
        assert.equal(path.relative(process.cwd(), content.outputFilePath), path.normalize('test/testStyle.css.d.ts'));
        done();
      });
    });

    it('can drop the original extension when asked', (done) => {
      void new DtsCreator({ dropExtension: true }).create(path.normalize('test/testStyle.css')).then((content) => {
        assert.equal(path.relative(process.cwd(), content.outputFilePath), path.normalize('test/testStyle.d.ts'));
        done();
      });
    });
  });

  describe('#formatted', () => {
    it('returns formatted .d.ts string', (done) => {
      void new DtsCreator().create('test/testStyle.css').then((content) => {
        assert.equal(
          content.formatted,
          `\
declare const styles: {
  readonly "myClass": string;
};
export = styles;

`,
        );
        done();
      });
    });

    it('returns named exports formatted .d.ts string', (done) => {
      void new DtsCreator({ namedExports: true }).create('test/testStyle.css').then((content) => {
        assert.equal(
          content.formatted,
          `\
export const __esModule: true;
export const myClass: string;

`,
        );
        done();
      });
    });

    it('returns camelcase names when using named exports as formatted .d.ts string', (done) => {
      void new DtsCreator({ namedExports: true }).create('test/kebabedUpperCase.css').then((content) => {
        assert.equal(
          content.formatted,
          `\
export const __esModule: true;
export const myClass: string;

`,
        );
        done();
      });
    });

    it('returns empty object exportion when the result list has no items', (done) => {
      void new DtsCreator().create('test/empty.css').then((content) => {
        assert.equal(content.formatted, '');
        done();
      });
    });

    describe('#camelCase option', () => {
      it('camelCase == true: returns camelized tokens for lowercase classes', (done) => {
        void new DtsCreator({ camelCase: true }).create('test/kebabed.css').then((content) => {
          assert.equal(
            content.formatted,
            `\
declare const styles: {
  readonly "myClass": string;
};
export = styles;

`,
          );
          done();
        });
      });

      it('camelCase == true: returns camelized tokens for uppercase classes ', (done) => {
        void new DtsCreator({ camelCase: true }).create('test/kebabedUpperCase.css').then((content) => {
          assert.equal(
            content.formatted,
            `\
declare const styles: {
  readonly "myClass": string;
};
export = styles;

`,
          );
          done();
        });
      });

      it('camelCase == "dashes": returns camelized tokens for dashes only', (done) => {
        void new DtsCreator({ camelCase: 'dashes' }).create('test/kebabedUpperCase.css').then((content) => {
          assert.equal(
            content.formatted,
            `\
declare const styles: {
  readonly "MyClass": string;
};
export = styles;

`,
          );
          done();
        });
      });
    });
  });

  describe('#writeFile', () => {
    it('accepts a postprocessor function', (done) => {
      void new DtsCreator()
        .create('test/testStyle.css')
        .then(async (content) => {
          return content.writeFile(
            (formatted) => `// this banner was added to the .d.ts file automatically.\n${formatted}`,
          );
        })
        .then(() => {
          done();
        });
    });

    it('writes a file', (done) => {
      void new DtsCreator()
        .create('test/testStyle.css')
        .then(async (content) => {
          return content.writeFile();
        })
        .then(() => {
          done();
        });
    });
  });
});
