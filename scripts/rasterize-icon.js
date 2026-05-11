const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const svgPath = path.join(__dirname, '..', 'matrap-icon.svg');
const outPath = path.join(__dirname, '..', 'icon.png');

const svg = fs.readFileSync(svgPath);
const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 128 },
    background: 'rgba(0,0,0,0)',
});
fs.writeFileSync(outPath, resvg.render().asPng());
console.log(`wrote ${outPath}`);
