// "Version 114.0.5708.0 (Official Build) canary (arm64)" compatible.

const STATE = {
    size: 1024.0,
    workgroups: 64,
    // Points
    // pointsCount : 15,
    // radiusMin: 8,
    // radiusMax: 96,
    pointsCount : 256,
    radiusMin: 4,
    radiusMax: 20,
    radiusGrowth: 0.25,
    speedRate: 1.5,
    valuesPerPoint: 6,
    storageData: new Float32Array([
        // centre x and y, velocity x and y, radius
        512.0, 512.0, 0.5, 0.5, 40.0, 1,
        256.0, 512.0, -0.5, 0.5, 30.0, 1,
        256.0, 256.0, 1.2, 1.0, 25.0, 1,
        200.0, 200.0, 3.0, 3.0, 128.0, 1,
        800.0, 800.0, 2.0, -1.0, 128.0, 1,
        580, 580, -2.0, -3.0, 30, 1,
    ]),
    // Controls, passed to uniforms
    uniforms: new Float32Array([
        0, // time
        1, // squareSize, Marching square size in absolute units.
        0, // useCirclesSDF
        1, // useSmoothInterpolate
        1, // useOutline
        0, // useRed
        0, // useWhite
        0, // useTime, whether to send the time value in and then use it in the shader for colours.
    ]),
    // Indicates that uniforms have chagned and must be updated.
    uniformsDirty: false,
}

STATE.storageData = generateRandomData(STATE.pointsCount, 1024);

function generateRandomData(count, size) {
    const randomFloat = (low, high) => Math.random() * (high - low) + low;
    const data = [];
    for (let i = 0; i < count; i++) {
        const randomRadius = randomFloat(STATE.radiusMin, STATE.radiusMax);
        // Ensure cx, cy doesn't go beyond bounds.
        const randomCentreX = randomFloat(randomRadius, size - randomRadius);
        const randomCentreY = randomFloat(randomRadius, size - randomRadius);
        const randomVX = randomFloat(-STATE.speedRate, STATE.speedRate);
        const randomVY = randomFloat(-STATE.speedRate, STATE.speedRate);
        const randomVR = Math.random() < 0.5 ? -STATE.radiusGrowth : STATE.radiusGrowth;
        data.push(randomCentreX, randomCentreY, randomVX, randomVY, randomRadius, randomVR);
    }
    return new Float32Array(data);
}

async function setupDevice() {
    const adapter = await navigator.gpu.requestAdapter();
    console.log('adapter', adapter);
    const device = await adapter.requestDevice();
    console.log('device', device);
    return device;
}

function setupCanvas(device) {
    const canvas = document.createElement('canvas');
    canvas.width = STATE.size;
    canvas.height = STATE.size;
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('webgpu');
    const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    console.log('canvasFormat', canvasFormat);
    ctx.configure({ device, format: canvasFormat });
    return ctx;
}

function setupData(device) {
    // Setup the quad that we'll draw to in 2D.
    const vertexData = new Float32Array([
        -1, -1, // top left
        -1, 1, // bottom left
        1, -1, // top right
        -1, 1, // bottom left
        1, -1, // top right
        1, 1, // bottom right
    ]);
    const vertexBuffer = device.createBuffer({
        label: 'vertex-buffer',
        size: vertexData.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(vertexBuffer, 0, vertexData);

    const uniformBuffer = device.createBuffer({
        label: 'uniform-buffer',
        size: STATE.uniforms.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(uniformBuffer, 0, STATE.uniforms);

    // Shared between the compute and fragment shader.
    // The compute shader updates these values, while the
    // fragment shader reads them back to know how to render
    // the next frame.
    const storageBuffer = device.createBuffer({
        label: 'storage-buffer',
        size: STATE.storageData.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(storageBuffer, 0, STATE.storageData);

    return { storageBuffer, uniformBuffer, vertexBuffer };
}

function setupComputePipeline({
    device,
    storageBuffer,
}) {
    const computeShader = `
        struct Point {
            cx: f32,
            cy: f32,
            vx: f32,
            vy: f32,
            r: f32,
            vr: f32,
        };

        @group(0) @binding(0) var<storage, read_write> points: array<Point>;
        @compute @workgroup_size(${STATE.workgroups})
        fn main(
            @builtin(global_invocation_id)
            global_id: vec3u,
            
            @builtin(local_invocation_id)
            local_id: vec3u,
        ) {
            const top: f32 = 0;
            const left: f32 = 0;
            const bottom: f32 = ${STATE.size};
            const right: f32 = ${STATE.size};

            // TODO
            // Maybe looping isn't needed. If we've already split this into workgroups
            // we can update the point by workgroup id?
            for (var i = 0; i < ${STATE.pointsCount}; i++) {
                // need to just modify the buffer of floats directly.
                var point = points[i];

                // TODO
                // This seems to be causing things to get stuck to the edges.
                // if (point.r <= ${STATE.radiusMin}) {
                //     point.r = ${STATE.radiusMin};
                //     point.vr = ${STATE.radiusGrowth};
                // }
                // if (point.r >= ${STATE.radiusMax}) {
                //     point.r = ${STATE.radiusMax};
                //     point.vr = -${STATE.radiusGrowth};
                // }
                // point.r += point.vr;

                let testBottom = point.r >= distance(bottom, point.cy);
                let testTop = point.r >= distance(top, point.cy);
                let testLeft = point.r >= distance(left, point.cx);
                let testRight = point.r >= distance(right, point.cx);

                if (testBottom || testTop) {
                    point.vy = -point.vy;
                }

                if (testLeft || testRight) {
                    point.vx = -point.vx;
                }

                point.cx += point.vx;
                point.cy += point.vy;
                points[i] = point;
            }
        }
    `;

    const computeShaderModule = device.createShaderModule({
        code: computeShader,
    });
    console.log("computeShaderModule", computeShaderModule);

    const bindGroupLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.COMPUTE,
                buffer: {
                    type: 'storage',
                },
            }
        ]
    });

    const computeBindGroup = device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: storageBuffer,
                }
            }
        ],
    });

    const pipelineLayout = device.createPipelineLayout({
        bindGroupLayouts: [bindGroupLayout],
    });

    const computePipeline = device.createComputePipeline({
        layout: pipelineLayout,
        compute: {
            module: computeShaderModule,
            entryPoint: 'main',
        },
    });
    console.log("compute pipeline", computePipeline);
    return { computeBindGroup, computePipeline };
}

function setupRenderPipeline({
    device,
    storageBuffer,
    uniformBuffer,
}) {
    const renderShader = `
        struct Uniforms {
            time: f32,
            squareSize: f32,
            useCirclesSDF: f32,
            useSmoothInterpolate: f32,
            useOutline: f32,
            useRed: f32,
            useWhite: f32,
            useTime: f32,
        };

        struct Point {
            cx: f32,
            cy: f32,
            vx: f32,
            vy: f32,
            r: f32,
            vr: f32,
        };

        @binding(0) @group(0) var<uniform> uniforms: Uniforms;
        @binding(1) @group(0) var<storage, read_write> points: array<Point>;

        struct VertexIn {
            @location(0) pos: vec2f,
        }

        struct VertexOut {
            // Every vertex shader must output a value with @builtin(position)
            @builtin(position) pos: vec4f,
        }

        @vertex
        fn vertexMain(in: VertexIn) -> VertexOut {
            var out: VertexOut;
            out.pos = vec4f(in.pos, 0.0, 1.0);
            return out;
        }

        fn circleSDF(point: vec2f) -> f32 {
            // TODO
            // Update using a uniform for the number of points?
            for (var i = 0; i < ${STATE.pointsCount}; i++) {
                let cx = points[i].cx;
                let cy = points[i].cy;
                let r = points[i].r;

                // r, cx, cy, pos, etc. are in absolute coordinates, i.e. not normalized.
                let d = distance(point, vec2f(cx, cy));
                // Outline, could be used for smoothing.
                // if (r - 2 < d && d < r + 2) {
                //     return vec4(1.0, 0.0, 0.0, 1.0);
                // }
                // Another outline
                // if (abs(r - d) < 1) {
                //     return 1.0;
                // }
                //
                // Fill
                if (d < r) {
                    return 1.0;
                }
            }
            return 0;
        }
   
        fn totalAtPoint(point: vec2f) -> f32{
            var total = 0.;
            for (var i = 0; i < ${STATE.pointsCount}; i++) {
                let cx = points[i].cx;
                let cy = points[i].cy;
                let r = points[i].r;

                // r, cx, cy, pos, etc. are in absolute coordinates, i.e. not normalized.
                let delta = point - vec2f(cx, cy);
                // Going to have to sum this up across multiply circles so the above should loop.
                let d = pow(r, 2) / (pow(delta.x, 2) + pow(delta.y, 2));
                total += d;
            }
            return total;
        }
        
        
        fn sdSegment(p: vec2f, a: vec2f, b: vec2f) -> f32 {
            let pa = p - a;
            let ba = b - a;
            let h = clamp(dot(pa, ba)/dot(ba, ba), 0.0, 1.0);
            return 1. - length(pa - ba * h);
        }
        
        // Non-interpolated version of generating the contour.
        fn lineFunction(point: vec2f, tl: vec2f, bitMask: u32) -> f32 {
            // Now figure out the edge midpoints so we can make a linear function to see
            // if we're on the edge between them or not.
            let size: f32 = uniforms.squareSize;
            let x = tl.x;
            let y = tl.y;
            let tm = vec2f(x + size * 0.5, y);
            let bm = vec2f(x + size * 0.5, y + size);
            let lm = vec2f(x, y + size * 0.5);
            let rm = vec2f(x + size, y + size * 0.5);
            var value = 0.;
            // Each of these corresponds to 0000 -> 1111 possible corner inclusion
            // values (see MAP_MASK above).
            // See: http://jamie-wong.com/images/14-08-11/marching-squares-mapping.png
            switch bitMask {
                case 0, 15: {
                    value = 0.; break;
                }
                case 1, 14: {
                    value = sdSegment(point, lm, bm); break;
                }
                case 2, 13: {
                    value = sdSegment(point, bm, rm); break;
                }
                case 3, 12: {
                    value = sdSegment(point, lm, rm); break;
                }
                case 4, 11: {
                    value = sdSegment(point, tm, rm); break;
                }
                case 6, 9: {
                    value = sdSegment(point, tm, bm); break;
                }
                case 7, 8: {
                    value = sdSegment(point, lm, tm); break;
                } 
                // Careful, ambiguous case. Assume always inside.
                // FIXME this and case 10 are wrong, need to try both lines.
                case 5: {
                    value = sdSegment(point, lm, tm);
                    if (value != 1.) {
                        value = sdSegment(point, bm, rm);
                    }
                    break;
                }
                // Careful, ambiguous case. Assume always inside.
                // FIXME this and case a are wrong, need to try both lines.
                case 10: {
                    value = sdSegment(point, lm, bm);
                    if (value != 1.) {
                        value = sdSegment(point, tm, rm);
                    }
                    break;
                }
                default: {
                    break;
                }
                
            }
            // To debug bitmasks.
            // return let(bitMask) / let(0xf);
            return value;
        }
        
        // Which square is it for a point,
        // 1. then call totalAtPoint for each corner
        // 2. then see if the point is in or out the shape
        // 3. then produce the line(s) for the square given the point index.
        // 4. going to need linear functions to then see if the pixel value (not square) itself is on the line
        // made by the edges.
        fn march(point: vec2f) -> f32 {
            let size: f32 = uniforms.squareSize;
            // Give the square's absolute top left corner...
            // vec2f tl = mod(point, size);
            // Gives which square we're on's top left corner, since we'll get an integer from point/size
            // which we'll ten advance by the size of the square which is fractional.
            let tl = floor(vec2f(point / size)) * size;
            let tr = tl + vec2f(size, 0.);
            let br = tl + size;
            let bl = tl + vec2f(0., size);
        
            // Check each corner to find what kind of edge we're dealing with.
            let corners = array<vec2f, 4>(bl, br, tr, tl);
            let masks = array<u32, 4>(0x1, 0x2, 0x4, 0x8);
            let total = 0.;
            var bitMask: u32 = 0;
            for (var i = 0; i < 4; i++) {
                if (totalAtPoint(corners[i]) >= 1.) {
                    bitMask |= masks[i];
                }
            }
            // To debug to see each marching square.
            // return tl;
            // To debug whether the bitmasking and corner testing is working.
            // return bitMask == 0 ? vec3(0.) : vec3(0., 0., 1.);
            let contourValue = lineFunction(point, tl, bitMask);
            return contourValue;
        }

        @fragment
        fn fragmentMain(data: VertexOut) -> @location(0) vec4f {
            let position = data.pos.xy;
            let useCirclesSDF = uniforms.useCirclesSDF == 1;
            // If set to false, increase the square size to see more blockiness
            let useSmoothInterpolate = uniforms.useSmoothInterpolate == 1;
            let useOutline = uniforms.useOutline == 1;
            let useRed = uniforms.useRed == 1;
            let useWhite = uniforms.useWhite == 1;
            let useTime = uniforms.useTime == 1;

            var total = totalAtPoint(position);
            
            // Colour settings.
            var colour = vec3f(position.x/${STATE.size}, position.y/${STATE.size}, 1);
            // White outline also looks good.
            // var outlineColour = vec3f(1);
            var outlineColour = vec3f(position.x/${STATE.size}, position.y/${STATE.size}, 1)  * 0.25;

            if (useTime) {
                colour.r = abs(cos(uniforms.time));
                colour.g = abs(sin(uniforms.time));
                colour.b = abs(sin(uniforms.time));

                outlineColour.r = abs(sin(uniforms.time));
                outlineColour.g = abs(sin(uniforms.time));
                outlineColour.b = abs(cos(uniforms.time));
            }

            if (useRed) {
                colour = vec3f(1, 0, 0);
                outlineColour = vec3f(0, 0, 1);
            }
            if (useWhite) {
                colour = vec3f(1);
                outlineColour = vec3f(-0.5);
            }

            // Drawing settings.
            if (useCirclesSDF) {
                let amount = circleSDF(position);
                colour = vec3f(amount, 0, 0);
            }
            if (!useSmoothInterpolate) {
                let size: f32 = uniforms.squareSize;
                let centre = (floor(vec2f(position / size)) * size) + size * 0.5;
                total = totalAtPoint(centre);
                colour *= total;
            }
            if (useSmoothInterpolate && (total < 1 || total >= 1)) {
                // Smoothens the colour interpolation between circles.
                // Basically causes the glow effect.
                // Will fill even if useCirclesSDF is false.
                // Multiplying total by a value reduces or increases the additivity
                // a fraction reduces, > 1 increases.
                // Multiplying a specific colour leads to an interesting effect.
                // colour.g *= total;
                colour *= total;
            }
            if (useOutline) {
                let amount = march(position);
                // To replace the colour with a solid blue for debugging
                // if (amount > 0){
                //     colour = vec3f(0, 0, 1);
                // }
                colour += outlineColour * amount;
            }

            // position will be in canvas space from [0, width] and [0, height]
            // so if it's 512 we can divide to normalize it seems.
            // return data.pos / ${STATE.size};
            return vec4f(colour, 1);
        }
    `;

    const renderShaderModule = device.createShaderModule({
        code: renderShader,
    });
    console.log("render shaderModule", renderShaderModule);

    // Bind the uniforms at binding(0) group(0).
    const bindGroupLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.FRAGMENT,
                buffer: {
                    type: 'uniform',
                },
            },
            {
                binding: 1,
                // Cannot be vertex-stage visibile.
                // That's fine, we don't want to do that for the storage one anyway.
                visibility: GPUShaderStage.FRAGMENT,
                buffer: {
                    type: 'storage',
                },
            },
        ],
    });
    // TODO
    // Rename or remove uniform? these will be bound together to bindings 0 and 1
    // in the shader respectively.
    const renderBindGroup = device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: uniformBuffer,
                    offset: 0,
                    size: STATE.uniforms.byteLength,
                },
            },
            {
                binding: 1,
                resource: {
                    buffer: storageBuffer,
                    offset: 0,
                    size: STATE.storageData.byteLength,
                },
            },
        ],
    });
    const pipelineLayout = device.createPipelineLayout({
        bindGroupLayouts: [bindGroupLayout],
    });
    const renderPipeline = device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: {
            module: renderShaderModule,
            entryPoint: 'vertexMain',
            buffers: [{
                arrayStride: 8, // 2 floats * 4 bytes per = 2 * 4 = 8.
                attributes: [{
                    shaderLocation: 0,
                    offset: 0,
                    format: 'float32x2', 
                }],
            }],
        },
        fragment: {
            module: renderShaderModule,
            entryPoint: 'fragmentMain',
            targets:[{
                format: navigator.gpu.getPreferredCanvasFormat(),
            }]
        }
    });
    console.log("render pipeline", renderPipeline);
    return { renderBindGroup, renderPipeline };
}

function setupCommands({
    context,
    computeBindGroup,
    computePipeline,
    device,
    renderPipeline,
    renderBindGroup,
    vertexBuffer
}) {
    const commandEncoder = device.createCommandEncoder();

    const computePassEncoder = commandEncoder.beginComputePass();
    computePassEncoder.setPipeline(computePipeline);
    computePassEncoder.setBindGroup(0, computeBindGroup);
    const elementsCount = STATE.storageData.length / 5;
    computePassEncoder.dispatchWorkgroups(Math.ceil(elementsCount/STATE.workgroups));
    computePassEncoder.end();

    // Setup the quad for drawing and make a render pass.
    const renderPassEncoder = commandEncoder.beginRenderPass({
        colorAttachments: [{
            view: context.getCurrentTexture().createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0.0, 0.5, 0.0, 1],
        }],
    });
    renderPassEncoder.setPipeline(renderPipeline);
    renderPassEncoder.setVertexBuffer(0, vertexBuffer);
    renderPassEncoder.setBindGroup(0, renderBindGroup);
    renderPassEncoder.draw(6);
    renderPassEncoder.end();

    const commandBuffer = commandEncoder.finish();
    return commandBuffer;
}

function setupControls() {
    // TODO
    // Find a better way to keep the mapping.
    // Should match STATE.uniforms.
    const controls = [
        { id: 'time', input: null },
        { id: 'squareSize', input: 'number' },
        { id: 'useCirclesSDF', input: 'radio' },
        { id: 'useSmoothInterpolate', input: 'radio' },
        { id: 'useOutline', input: 'radio' },
        { id: 'useRed', input: 'radio' },
        { id: 'useWhite', input: 'radio' },
        { id: 'useTime', input: 'radio' },
    ];
    const controlsEl = document.createElement('div');

    controls.forEach(({ id, input }, i) => {
        if (input == null) {
            return;
        }

        const control = document.createElement('input');
        control.id = id;
        control.type = input;
        
        if (input === 'radio') {
            control.checked = STATE.uniforms[i] === 1;
            control.value = id;
            
        }
        if (input === 'number') {
            control.min = 0.01;
            control.step = 0.01;
            control.value = STATE.uniforms[i];
        }

        const label = document.createElement('label');
        label.innerText = id;
        label.for = id;

        const handler = (e) => {
            if (input === 'radio') {
                // console.log("changed", id);
                if (STATE.uniforms[i] === 0) {
                    STATE.uniforms[i] = 1;
                } else {
                    STATE.uniforms[i] = 0;
                }
                control.checked = STATE.uniforms[i] === 1;
            }
            
            if (input == 'number') {
                STATE.uniforms[i] = parseFloat(e.target.value);
            }
            STATE.uniformsDirty = true;
        };

        control.addEventListener('change', handler);
        label.addEventListener('click', handler);

        controlsEl.appendChild(control);
        controlsEl.appendChild(label);
    });
    document.body.appendChild(controlsEl);
}

function updateUniforms({ device, uniformBuffer }) {
    if (!STATE.uniformsDirty) {
        return;
    }
    STATE.uniformsDirty = false;
    device.queue.writeBuffer(uniformBuffer, 0, STATE.uniforms);
}

async function main() {
    if (!("gpu" in navigator)) {
        console.log("webgpu not supported")
        alert("webgpu not supported")
        return;
    }
    console.log(navigator);
    const device = await setupDevice();
    const context = setupCanvas(device);
    const { storageBuffer, uniformBuffer, vertexBuffer } = setupData(device);
    const { computeBindGroup, computePipeline } = setupComputePipeline({
        device,
        storageBuffer,
    });
    const { renderBindGroup, renderPipeline } = setupRenderPipeline({
        device,
        storageBuffer,
        uniformBuffer,
    });
    setupControls();
    function renderLoop(t) {
        const useTime = STATE.uniforms[7] === 1;
        if (useTime) {
            STATE.uniforms[0] = t/10000;
            STATE.uniformsDirty = true;
        }
        updateUniforms({ device, uniformBuffer });
        const commands = setupCommands({
            context,
            computeBindGroup,
            computePipeline,
            device,
            renderBindGroup,
            renderPipeline,
            vertexBuffer
        });
        device.queue.submit([commands]);
        window.requestAnimationFrame(renderLoop);
    }

    window.requestAnimationFrame(renderLoop);
}

main();

/**
 * Approach
 * 
 * 1. positions/velocities buffer, read/write for compute shader.
 * 2. radiuses uniform? or maybe it goes along with positions/velocities?
 * 3. colours uniform?
 * 4. positions/velocities buffer gets updated in compute
 * 5. then render pass happens taking that as a read only buffer.
 * 6. quad buffer and compute colours in fragment shader.
 *
 */