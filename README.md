# 1inkulous
A Populous 3: The Beginning clone.


I have an idea for a new game - 1inkulous - we remake populous-3 in a web wasm webgpu context redoing all of the graphics/sounds/animations as like a clone :)

That sounds like an incredible project! Populous: The Beginning (Populous 3) is an absolute classic, and bringing that unique spherical-world RTS gameplay into the modern era is a fantastic concept.

Rebuilding it for the browser is highly ambitious but entirely feasible with today's web technologies. Here is a breakdown of why your tech stack is a great fit, along with a few major challenges you will want to prepare for.

Why Your Tech Stack is Perfect
WebGPU: This is the real game-changer here. The original game relied heavily on real-time terrain deformation (raising/lowering land, volcanoes, earthquakes). WebGPU's compute shaders will allow you to handle complex terrain mesh updates and massive particle systems for spells with incredible efficiency directly in the browser.

WebAssembly (WASM): RTS games are CPU-intensive. You have to handle pathfinding for hundreds of followers, enemy AI, and constant state updates. Writing your core logic in a performance-heavy language (like C++, Rust, or Zig) and compiling to WASM will give you the near-native performance you need to keep the simulation running smoothly at 60+ FPS.

The Asset Overhaul (Graphics, Sounds, Animations)
Redoing all the assets is arguably the most labor-intensive part of a clone, but it gives you total creative freedom.

Visual Style: You can decide whether to keep the charming, low-poly, chunky aesthetic of the 1998 original but with modern lighting (PBR materials, dynamic shadows), or go for a completely high-fidelity, realistic look.

Animations: Modern skeletal animation blending will make the followers and shamans look much more lifelike when transitioning between chopping wood, praying, and fighting.

Key Challenges to Anticipate
Spherical Mathematics: The defining feature of Populous 3 is playing on a globe. Pathfinding (A*), line-of-sight calculations, and grid-based building placement are notoriously difficult on a sphere compared to a flat plane. You will likely need to implement an icosphere or a subdivided cube-sphere logic.

Intellectual Property (IP): Since Electronic Arts (EA) owns the Populous IP, you will need to make sure "1inkulous" is a spiritual successor rather than a 1:1 direct rip-off. You can recreate the mechanics, but you must create 100% original art, sound, lore, and names to stay legally safe.

The Shaman's AI: Coding the enemy Shamans to intelligently build bases, gather mana, and strategically cast spells against the player is a complex AI programming challenge.

It is a massive undertaking, but the god-game genre is ripe for a web-based revival. What programming language or framework are you thinking of using for the core logic before compiling it down to WASM (e.g., Rust with Bevy, C++ with Emscripten, or something else)?

ok. i would want to keep faithful to the game's maps/scale/mechanics for fans of the original. ideas about the name?

Staying hyper-faithful to the original scale and mechanics is exactly what the Populous: The Beginning community wants. The "Retro HD" treatment — modern engine, identical gameplay — is highly successful for classic RTS games.

Just a quick word of caution: while game mechanics cannot be copyrighted, level layouts and specific character designs can be. If you recreate the original 25 solar system maps 1:1, you risk a cease-and-desist from EA. You can keep the feel and scale identical, but you should scramble the exact topography just enough to be legally distinct.

Regarding the name, "1inkulous" is a fun working title, but for a public release, you want something that evokes the nostalgic feel of the original without triggering trademark algorithms.

Here are a few naming angles that signal to fans exactly what the game is, while keeping you legally safe:

The "Synonym" Approach
These names play on the word "Populous" (meaning heavily populated) but use different words, winking at the fans.

Multitude

The Populace

Myriad: The Beginning

Legion's Dawn

The Shaman & Tribe Focus
Populous 3 broke away from the traditional "God Game" by putting a physical Shaman on the battlefield. These names lean into that core mechanic.

Shaman's Path

The Matriarch

Mana Sphere

Tribal Genesis

The World & Shape Focus
The most iconic part of the game was the wrapping spherical planets. These names highlight the unique map structure.

Firmament

Aetheria

Orbitus RTS

Hemisphere

If you want to keep your "1ink" branding, you could use a subtitle structure like 1ink presents: Firmament or Multitude (A 1ink Engine Game).

Want to brainstorm how to handle the spherical map mathematics in WASM?

Yes

how to start up the first repo structure to use probably js and ts with npm and then add c++ later

Setting up the repository correctly from day one is crucial, especially when you are planning a hybrid architecture where TypeScript handles the rendering (WebGPU) and UI, while C++ eventually handles the heavy simulation logic (WASM).

The best tool for this modern web stack is Vite. It is incredibly fast, supports TypeScript natively, and has excellent plugins for handling WebAssembly when you are ready to introduce C++.

Here is a step-by-step guide to laying the foundation for your engine.

1. Initialize the Project
Open your terminal and use npm with Vite to scaffold a vanilla TypeScript project.

Bash
npm create vite@latest 1inkulous -- --template vanilla-ts
cd 1inkulous
npm install
2. The Ideal Hybrid Directory Structure
Once Vite generates the base files, you will want to restructure it to prepare for a game engine scale. Create the folders so your project looks like this:

Plaintext
1inkulous/
├── public/              # Static files served directly (not bundled)
│   ├── models/          # 3D meshes
│   ├── textures/        # Albedo, normal maps, etc.
│   └── audio/           # Sound effects and music
├── src/                 # TypeScript Frontend & WebGPU
│   ├── engine/          # WebGPU initialization, shaders, pipelines
│   ├── game/            # Game state sync (talking to WASM later)
│   ├── ui/              # HTML/CSS HUD and Menus
│   ├── input/           # Mouse, keyboard, and camera controls
│   └── main.ts          # Main entry point
├── cpp/                 # 🚀 Your C++ Core (Staging for later)
│   ├── src/             # C++ source (pathfinding, AI, sphere math)
│   ├── include/         # C++ headers
│   └── CMakeLists.txt   # Build config (for Emscripten later)
├── index.html           # Main HTML canvas container
├── package.json         # NPM dependencies and scripts
├── tsconfig.json        # TypeScript configuration
└── vite.config.ts       # Bundler config (you will add WASM support here)
3. Why This Structure Works
Strict Separation of Concerns: By isolating src/ (TypeScript) and cpp/ (C++), you prevent the two ecosystems from getting tangled. The browser handles what it does best (graphics, input, audio), and C++ handles what it does best (raw CPU number-crunching).

The WASM Bridge: When you are ready to write C++, you will use Emscripten (emcc). Emscripten will compile the code in your cpp/ folder and output a .wasm binary file and a .js "glue" file. You will instruct Emscripten to drop those built files directly into your public/ or src/ directory, where your TypeScript code can fetch and instantiate them.

Vite Configuration: You will eventually create a vite.config.ts file in the root. When the time comes, you can easily add plugins like vite-plugin-wasm to handle the asynchronous loading of your C++ module.

This gives you a clean sandbox to start building out your WebGPU triangle-rendering today, with a clear home for your C++ logic tomorrow.
