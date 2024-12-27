// "Version 114.0.5708.0 (Official Build) canary (arm64)" compatible.

const STATE = {
    size: 1024.0,
    workgroups: 64,
    count: 64,
    storageData: new Float32Array([
        // centre x and y, velocity x and y, radius
        512.0, 512.0, 0.0, 0.0, 10.0,
        256.0, 512.0, 0.0, 0.0, 20.0,
        256.0, 256.0, 0.0, 0.0, 15.0,
    ]),
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

    const storageBuffer = device.createBuffer({
        label: 'storage-buffer',
        size: STATE.storageData.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    // will probably need to keep updating this?
    device.queue.writeBuffer(storageBuffer, 0, STATE.storageData);

    return { storageBuffer, vertexBuffer };
}

function setupRenderPipeline(device, storageBuffer) {
    const shader = `
        struct Point {
            cx : f32,
            cy : f32,
            vx : f32,
            vy : f32,
            r : f32,
        };

        @binding(0) @group(0) var<storage, read_write> points : array<Point>;

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

        @fragment
        fn fragmentMain(data: VertexOut) -> @location(0) vec4f {
            // position will be in canvas space from [0, width] and [0, height]
            // so if it's 512 we can divide to normalize it seems.
            // return vec4f(data.pos.xy / ${STATE.size}, 1.0, 1.0);

            // Update using a uniform for the number of points.
            for (var i = 0; i < ${STATE.storageData.length / 5}; i++) {
                // Doing this can give us some -really strange- results because we may
                // mutate this rw buffer before all the pixels get drawn.
                points[i].cx += 1;
                points[i].cy += 2;
                let cx = points[i].cx;
                let cy = points[i].cy;
                let r = points[i].r;

                // r, cx, cy, pos, etc. are in absolute coordinates, i.e. not normalized.
                let dx = cx - data.pos.x;
                let dy = cy - data.pos.y;
                let distance = sqrt(dx * dx + dy * dy);
                if (distance < r) {
                    return vec4(1.0, 0.0, 0.0, 1.0);
                }
            }

            return data.pos / ${STATE.size};
        }
    `;

    const shaderModule = device.createShaderModule({
        code: shader,
    });
    console.log("render shaderModule", shaderModule);

    const bindGroupLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                // Cannot be vertex-stage visibile.
                // That's fine, we don't want to do that for the storage one anyway.
                visibility: GPUShaderStage.FRAGMENT,
                buffer: {
                    type: 'storage',
                },
            },
        ],
    });
    const storageBindGroup = device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
            {
                binding: 0,
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
            module: shaderModule,
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
            module: shaderModule,
            entryPoint: 'fragmentMain',
            targets:[{
                format: navigator.gpu.getPreferredCanvasFormat(),
            }]
        }
    });
    console.log("render pipeline", renderPipeline);
    return { renderPipeline, storageBindGroup };
}

function setupCommands({
    device,
    context,
    renderPipeline,
    storageBindGroup,
    vertexBuffer
}) {
    const commandEncoder = device.createCommandEncoder();

    // TODO
    // Setup the compute shader to run to update positions, velocities, etc.

    // Setup the quad for drawing and make a render pass.
    const passEncoder = commandEncoder.beginRenderPass({
        colorAttachments: [{
            view: context.getCurrentTexture().createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0.0, 0.5, 0.0, 1],
        }],
    });
    passEncoder.setPipeline(renderPipeline);
    passEncoder.setVertexBuffer(0, vertexBuffer);
    passEncoder.setBindGroup(0, storageBindGroup);
    passEncoder.draw(6);
    passEncoder.end();

    const commandBuffer = commandEncoder.finish();
    return commandBuffer;
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
    const { storageBuffer, vertexBuffer } = setupData(device);
    const { renderPipeline, storageBindGroup } = setupRenderPipeline(device, storageBuffer);
    const commands = setupCommands({
        device,
        context,
        renderPipeline,
        storageBindGroup,
        vertexBuffer
    });
    device.queue.submit([commands]);
}

main();