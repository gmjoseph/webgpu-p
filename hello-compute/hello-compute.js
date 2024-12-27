// "Version 114.0.5708.0 (Official Build) canary (arm64)" compatible.

const SIZE = 1024;
const WORKGROUPS = 64;

async function setupDevice() {
    // tl;dr adapter -> device -> device + configured canvas ctx
    // so device can putput to canvas

    // 1. get the adapter. this must be done before anything else since it's a representation
    // of the physical gpu.
    // can be called with options "features" "limits"
    const adapter = await navigator.gpu.requestAdapter();
    console.log('adapter', adapter);

    // 2. adapter -> gpu device
    // can be called with options
    const device = await adapter.requestDevice();
    console.log('device', device);

    return device;
}

function setupData(device) {
    // 3. create buffers
    // one buffer is the buffer we write to from the gpu.
    // the other buffer is one where we copy from gpu to cpu.
    // then finally, we use that last buffer to go from cpu to js.

    // make the buffer object to get data out the gpu
    const gpuOutputBuffer = device.createBuffer({
        size: SIZE,
        // store gpu data, make it readable/writable after creation.
        // if this didn't include COPY_SRC, we couldn't use it as a source buffer
        // to copy into the destination buffer (gpuToCpuCopyBuffer) below.
        // if this didn't have the STORAGE qualifier, it wouldn't be able to be
        // read in the GPU for storage output.
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const gpuToCpuCopyBuffer = device.createBuffer({
        size: SIZE,
        // allow reads from cpu, will be used to copy gpuOutputBuffer to this buffer
        // and then read into js.
        // if this were MAP_WRITE, for example, we wouldn't be able to call
        // mapAsync on it below with READ mode.
        // if this didn't include COPY_DST, we couldn't copy from gpuOutputBuffer
        // to this buffer.
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    })

    return { gpuOutputBuffer, gpuToCpuCopyBuffer };
}

function setupPipeline(device, buffer) {
    // the pipeline groups the shaders, blend modes, other render state.
    // see how it's setting up the shader code.
const shader = `
// @group(0) @binding(0) var<storage, read_write> output: array<u32>;
@group(0) @binding(0) var<storage, read_write> output: array<f32>;

@compute @workgroup_size(${WORKGROUPS})
fn main(
    @builtin(global_invocation_id)
    global_id : vec3u,
    
    @builtin(local_invocation_id)
    local_id : vec3u,
) {
    // avoid out of bounds buffer access
    if (global_id.x > ${SIZE}) {
        return;
    }
    // workgroups operate in 3d apparently, but in this case we've got a
    // buffer of SIZE elements of 1 x 1 dimension so:
    // x E [0, SIZE)
    // y E 0
    // z? E 0
    // so the x values will go from 0 to size for indexing into output.
    //
    // i believe global_id will increment across workgroups. if using local_id
    // it will go from [0, 63?] as it populates the buffer in the f32 case.
    output[global_id.x] = f32(global_id.x);
    // output[global_id.x] = global_id.x;
}
`;

    // 4. create the shader module with the code above (i assume this is similar to compiling
    // a shader in webgl, linking fragment and vertex, since we then refer to this by handle
    // below when making the pipeline)

    const shaderModule = device.createShaderModule({
        code: shader,
    });
    console.log("shaderModule", shaderModule);

    // 5. make the pipeline, this doesn't really have a webgl equivalent but basically
    // it seems to be grouping buffers, shader code, etc. into all the renderable junk?
    // https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/createComputePipeline

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

    const bindGroup = device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer,
                }
            }
        ],
    });

    const pipelineLayout = device.createPipelineLayout({
        bindGroupLayouts: [bindGroupLayout],
    });

    const pipeline = device.createComputePipeline({
        layout: pipelineLayout,
        compute: {
            module: shaderModule,
            entryPoint: 'main',
        },
    });
    console.log("pipeline", pipeline);
    return { pipeline, bindGroup };
}

function setupCommands(device, pipeline, bindGroup, gpuOutputBuffer, gpuToCpuCopyBuffer) {
    // notice that this is pulling device, pipeline, and bindGroup (which leads to
    // the buffer) all together since that's what's needed to actually compute.

    // records all the commands
    const commandEncoder = device.createCommandEncoder();
    const passEncoder = commandEncoder.beginComputePass();
    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.dispatchWorkgroups(SIZE / WORKGROUPS);
    passEncoder.end();
    
    // copy from gpu buffer
    commandEncoder.copyBufferToBuffer(
        gpuOutputBuffer,
        0, // src offset
        gpuToCpuCopyBuffer,
        0, // dst offset
        SIZE,
    );

    // at this point the compute is setup but we haven't run it yet, we've just made a list of
    // commands and specified the data to use.
    // we're done recording commands.
    const commandBuffer = commandEncoder.finish();
    return commandBuffer;
}

async function readData(gpuToCpuCopyBuffer) {
    await gpuToCpuCopyBuffer.mapAsync(
        GPUMapMode.READ,
        0,
        SIZE,
    );
    // this is a js data thing (the 'array buffer')
    // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/ArrayBuffer
    const copyArrayBuffer = gpuToCpuCopyBuffer.getMappedRange(0, SIZE);
    console.log("copyArrayBuffer", copyArrayBuffer);
    // slice is required because it's using memory from `gpuToCpuCopyBuffer`.
    // this works until we unmap it below, and after that we can't access that
    // memory any longer. that's why we use slice to make a copy.
    const data = new Float32Array(copyArrayBuffer.slice());
    // const data = new Uint32Array(copyArrayBuffer.slice());
    // we got the data, we can unmap
    gpuToCpuCopyBuffer.unmap();
    return data;

    // TODO
    // a) figure out the mapAsync, getMappedRange, etc. functions and where they fit in.
}

async function main() {
    if (!("gpu" in navigator)) {
        console.log("webgpu not supported")
        alert("webgpu not supported")
        return;
    }
    console.log(navigator);
    const device = await setupDevice();
    const { gpuOutputBuffer, gpuToCpuCopyBuffer } = setupData(device);
    const { pipeline, bindGroup } = setupPipeline(device, gpuOutputBuffer);
    const commands = setupCommands(device, pipeline, bindGroup, gpuOutputBuffer, gpuToCpuCopyBuffer);
    // finally computes.
    device.queue.submit([commands]);
    // now we can read back to JS after doing the compute
    // we need to map it to js memory first
    const data = await readData(gpuToCpuCopyBuffer);
    console.log(data);
}

main();