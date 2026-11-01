import { describe, expect, it } from 'vitest';
import { streamObjectArray } from '../src/ai/json-stream';

describe('incremental structured product JSON', () => {
  it('emits each complete product before the array or response ends', async () => {
    const items: unknown[] = [];
    const write = streamObjectArray('products', async item => { items.push(item); });
    const first = { name: 'First', offers: [{ quote: 'literal } ] \\" text' }] };
    await write(`{"summary":${JSON.stringify('not a product: "products": [{}]')},"products":[${JSON.stringify(first)}`);
    expect(items).toHaveLength(1);
    await write(',{"name":"Sec');
    expect(items).toHaveLength(1);
    await write('ond"}]}');
    expect(items).toEqual([first, { name: 'Second' }]);
  });
  it('handles every character boundary, escaped keys and nested arrays without exposing nested objects', async () => {
    const products = [{ name: 'A "quoted" \\ name', offers: [{ nested: [{ quote: '[]{}' }] }] }, { name: 'B' }];
    const items: unknown[] = [];
    const write = streamObjectArray('products', async item => { items.push(item); });
    const json = JSON.stringify({ other: { products: [{ ignored: true }] }, products }).replace('"products":[{"name"', '"produc\\u0074s":[{"name"');
    for (const char of json) await write(char);
    expect(items).toEqual(products);
  });
  it('awaits persistence and propagates callback failures', async () => {
    const write = streamObjectArray('products', async () => { throw new Error('Cannot persist'); });
    await expect(write('{"products":[{}]}')).rejects.toThrow('Cannot persist');
  });
});
