const fs = require('fs');

function convertGfxToJson(inputFile, outputFile) {
    const raw = fs.readFileSync(inputFile, 'utf8');
    const lines = raw.split('\n');
    
    // Default to standard 8x12
    let gridWide = 8;
    let gridTall = 12;
    
    // 1. Pre-scan for the dimension file 'd' to calculate string offsets
    for (let line of lines) {
        line = line.trim();
        if (line.startsWith('d=')) {
            const dims = line.substring(2).toLowerCase().split('x');
            gridWide = parseInt(dims[0], 10);
            gridTall = parseInt(dims[1], 10);
        }
    }

    const tileCharCount = gridWide * gridTall * 2;
    const entries = [];
    
    // Helper to format DOS files
    function addFile(path, content) {
        entries.push({
            name: path,
            type: "file",
            content: content,
            size: Buffer.byteLength(content, 'utf8'),
            timestamp: new Date().toISOString().replace(/[-:T.]/g, '').substring(0, 14),
            owner: "system",
            session: "system",
            readOnly: false
        });
    }

    // Helper to format DOS directories
    function addDir(path) {
        entries.push({
            name: path,
            type: "directory",
            content: "",
            size: 0,
            timestamp: new Date().toISOString().replace(/[-:T.]/g, '').substring(0, 14),
            owner: "system",
            session: "system",
            readOnly: false
        });
    }
    
    // Create base namespaces
    addDir('w');
    addDir('a');

    // Establish modern Cylon OS Alpha settings
    addFile('a/gfxGridWide', gridWide.toString());
    addFile('a/gfxGridTall', gridTall.toString());

    // 2. Process all lines
    for (let line of lines) {
        line = line.trim();
        if (!line) continue;
        
        const eqIdx = line.indexOf('=');
        if (eqIdx < 0) continue;
        
        const sectorId = line.substring(0, eqIdx);
        const rest = line.substring(eqIdx + 1);
        
        if (sectorId === '##') continue; // Skip old metadata
        
        // Global System files (1 char)
        if (sectorId.length === 1) {
            if (sectorId === 'd') continue; // We already migrated 'd' to 'a/gfxGridWide'
            addFile('w/' + sectorId, rest);
            continue;
        }
        
        // Map Sectors (2 chars)
        const dotIdx = rest.indexOf('.');
        const mapData = dotIdx >= 0 ? rest.substring(0, dotIdx) : rest;
        const itemData = dotIdx >= 0 ? rest.substring(dotIdx + 1) : '';
        
        // Dynamically slice using the map dimensions, fixing the bug!
        const tiles = mapData.substring(0, tileCharCount);
        const exits = mapData.substring(tileCharCount);
        
        addDir(`w/${sectorId}`);
        addFile(`w/${sectorId}/m`, tiles);
        addFile(`w/${sectorId}/e`, exits);
        
        // Extract punch-code items and static objects
        if (itemData) {
            const rawItems = itemData.split('~');
            for (let blob of rawItems) {
                blob = blob.trim();
                if (!blob) continue;
                
                const parts = blob.split('|');
                const itemName = parts[0];
                const itemContent = parts[1] || ''; // Punch code inside the item
                
                addFile(`w/${sectorId}/${itemName}`, itemContent.replace(/\\n/g, '\n'));
            }
        }
    }
    
    const driveName = inputFile.split(/[\/\\]/).pop().split('.')[0];
    
    const archive = {
        format: "qandy-ramdrive",
        version: 2,
        drive: driveName,
        created: new Date().toISOString(),
        entries: entries.sort((a,b) => a.name.localeCompare(b.name))
    };
    
    fs.writeFileSync(outputFile, JSON.stringify(archive, null, 2), 'utf8');
    console.log(`\nSuccess: Converted ${inputFile} -> ${outputFile}`);
    console.log(`Map properly scaled to: ${gridWide}x${gridTall} (${tileCharCount} characters per sector)`);
}

// CLI Execution
const args = process.argv.slice(2);
if (args.length < 2) {
    console.log("Usage: node convert-gfx.js input.gfx output.json");
} else {
    convertGfxToJson(args[0], args[1]);
}