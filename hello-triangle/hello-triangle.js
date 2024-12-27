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

function setupCanvas(device) {
    // 3. devices can't do anything by themselves, need a context to output to
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 1024;
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('webgpu');
    // the format is data i believe
    // e.g bgra8unorm (blue green red alpha 8-bit, unsigned integer, normalized?)
    // "Returns an optimal GPUTextureFormat for displaying 8-bit depth, standard dynamic range content on this system. Must only return "rgba8unorm" or "bgra8unorm"
    const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    console.log('canvasFormat', canvasFormat);
    ctx.configure({ device, format: canvasFormat });
    // more important configuration can be done in the above like render targets, usage of the
    // backing texture.
    // {
    //      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    //      alphaMode: 'opaque'
    // }
    // for example. seems similar to configuring a framebuffer attachment in webgl
    
    // TODO:
    // a) I wonder if the canvas can be setup later or after the pipeline
    // b) can we swap to a new canvas? multiple canvases?
    return ctx;
}

function setupPipeline(device) {
    // the pipeline groups the shaders, blend modes, other render state.
    // see how it's setting up the shader code.

    // NOTE
    // don't split this up into two pieces of code, it needs to be
    // one to compile the shader module correctly.
const shader = `
    // Every vertex attribute input is identified by a @location, which
    // matches up with the shaderLocation specified during pipeline creation.
    struct VertexIn {
        @location(0) pos: vec3f,
        @location(1) color: vec4f,
    }

    struct VertexOut {
        // Other outputs are given a @location so that they can map to the
        // fragment shader inputs.
        @location(0) color: vec4f,
        // Every vertex shader must output a value with @builtin(position)
        @builtin(position) pos: vec4f,
    }
    // Shader entry points can be named whatever you want, and you can have
    // as many as you want in a single shader module.
    @vertex
    fn vertexMain(in: VertexIn) -> VertexOut {
        var out: VertexOut;
        out.pos = vec4f(in.pos, 1.0);
        out.color = in.color;
        return out;
    }
    @fragment
    fn fragmentMain(data: VertexOut) -> @location(0) vec4f {
        return data.color;
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
    // this is basically like a combo of all these webgl functions:
    // glUseProgram (bind the shader module we made above)
    // glVertexAttribX (specify the shape of the data we put into a buffer)
    // see https://developer.mozilla.org/en-US/docs/Web/API/GPUPipelineLayout

    // const bindGroupLayout = device.createBindGroupLayout({
    //     entries: [
    //         {
    //             binding: 0,
    //             visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
    //             buffer: {},
    //         }
    //     ]
    // });

    const pipelineLayout = device.createPipelineLayout({
        // should be the same as using the default layout. i used to actually
        // create the bindgroup layout but i don't think that works because then
        // you need a bind group and then you need to use that bind group that's created
        // or something?
        bindGroupLayouts: [],
        // optional layout label
    });
    const pipeline = device.createRenderPipeline({
        // demo used "auto" but maybe this isn't supported at the moment and it seems
        // to require a pipeline layout object.
        // layout: 'auto',
        layout: pipelineLayout,
        vertex: {
            // see how we're using the 'handle'?
            module: shaderModule,
            // should match the name of the fn in the vertex code above.
            entryPoint: 'vertexMain',
            // the data shape (note that this isn't the data itself).
            // maybe this is like webgl.drawArray or something because we need to specify
            // the buffer format when making the drawcall?
            // this will be buffer 0 and must be specified below in setVertexBuffer.
            buffers: [{
                // buffer is interleaved position (xyz) and colour (rgba) of floats.
                // each float is 4 bytes
                arrayStride: 28, // (3 floats + 4 floats) * 4 bytes per = 4 * 7 = 28
                // this seems similar to webgl.vertexAttribPointer kind of stuff, where
                // we're specifying where the data maps to what in the shader.
                attributes: [{
                    // put the offset at 0, send the fist 3 32 bit floats to shader loc 0
                    shaderLocation: 0,
                    offset: 0,
                    format: 'float32x3', 
                }, {
                    // put the offset at 12 (3 floats at 4 bytes each in, past the position data)
                    // send 4 of those floats to shader loc 1
                    shaderLocation: 1,
                    offset: 12,
                    format: 'float32x4',
                }]
            }]
        },
        fragment: {
            module: shaderModule,
            entryPoint: 'fragmentMain',
            // `targets` indicates the format of each render target this pipeline
            // outputs to. It must match the colorAttachments of any renderPass it's
            // used with.
            targets:[{
                // must match the format we used above for the render target as setup in teh
                // canvas:
                // `const canvasFormat = navigator.gpu.getPreferredCanvasFormat();`
                format: navigator.gpu.getPreferredCanvasFormat(),
            }]
        }
    });
    // TODO
    // a) find out more about targets, can we do an offscreen target? can we change targets
    // after creating the pipeline? etc.
    // b) similarly, can we update the data and extend it to 4 + 4 floats or something? what
    // about updating the buffer after we've specified this location?
    // c) seems pretty tightly coupled to whatever 'shaderModule' we made, supposing the
    // module's layout is the same, and the amount of data it takes is the same, can we
    // hotswap the shaderModule for this pipeline?
    console.log("pipeline", pipeline);
    return pipeline;
}

function setupData(device) {
    // 6. we specified the data layout in the pipeline, now we need to actually make
    // data buffers (and fill them, but i'm actually not sure if at this point the
    // buffer data gets into the gpu memory or if that happens later).
    // seems like a combo of glCreateBuffer, glBufferData (though it may differ in terms
    // of not putting the data immediately in gpu memory)
    // the COPY_DST seems like a hint (and permission!) that we can update this buffer
    // after it's been made in the gpu state.

    // interleaved, xyz,rgba per # of points
    const vertexData = new Float32Array([
        0, 1, 1, // p0 xyz bottom left
        1, 0, 0, 1, // p0 rgba
        -1, -1, 1, // p1 xyz
        0, 1, 0, 1, // p1 rgba
        1, -1, 1, // p2 xyz
        0, 0, 1, 1, // p2 rgba
    ]);

    // make the buffer object
    const vertexBuffer = device.createBuffer({
        // how many bytes is the size
        size: vertexData.byteLength,
        // usage is important because it says what can be done with the buffer.
        // VERTEX means it can go into setVertexBuffer (see the 'passEncoder'/'commandEncoder'
        // further on.)
        // COPY_DST lets us write or copy data into the buffer after we make it
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    // Is this the same as glBufferData? or is it just queued for write and gpu
    // upload will happen later?
    device.queue.writeBuffer(vertexBuffer, 0, vertexData);
    return vertexBuffer;
}

function setupCommands(device, context, pipeline, vertexBuffer) {
    // 7. we need to now take all this and draw something finally.
    // there is a parallel to webgl drawArrays/drawElements here, except it doesn't
    // happen immediately, we're setting up the commands to do the drawing.
    // we then send those commands to be processed and all that happens in the API
    // after all this setup.

    // notice that this is pulling device, context, pipeline, and buffer
    // all together since that's what's needed to actually draw.

    // records all the commands
    const commandEncoder = device.createCommandEncoder();

    // holds rendering commands that happen under a 'render pass'
    // https://developer.mozilla.org/en-US/docs/Web/API/GPUCommandEncoder/beginRenderPass
    // can do stencil, maybe depth as well
    const passEncoder = commandEncoder.beginRenderPass({
        // where we're going to write to. this seems to be like the webgl
        // equivalent of picking a framebuffer.
        // it also seems to encapsulate some of the glClear and glClearColor info
        colorAttachments: [{
            // we're using the canvas context, everything will get written to here.
            // seems like this could be where we could draw to multiple places or
            // swap the output context? maybe similar to setting glFrameBuffer,
            // or updating the attachment of a framebuffer.
            view: context.getCurrentTexture().createView(),
            // glClear by default?
            loadOp: 'clear',
            // the clear colour
            // clearValue: [0, 0, 0.2, 1],
            // store the data in teh attachment tex when done drawing.
            storeOp: 'store',
            // not sure what this should be, seems to be what _actually_ gets loaded
            // for the clear because if it's set to an empty array we get a black
            // colour rather than this very dark blue.
            // in fact we can turn off the `clearValue` and use loadValue because
            // clearValue seems to no longer apply.
            loadValue: [0, 0, 0.2, 1],
        }],
    });

    // TODO
    // a) what if we don't do `storeOp: 'store'`
    // b) i wonder how this works with compute? maybe no colorAttachments but just some compute
    // attachment instead or no 'renderPass' to begin with since there's nothing to render,
    // just data to work on and then send out?
    // c) i wonder if we can set multiple views, maybe by adding a second colorAttachment?

    // use this pipeline, i imagine we can swap that out after making a pass?
    passEncoder.setPipeline(pipeline);
    // passEncoder.setBindGroup(0, )
    // 0 must match the index of the buffers array in the pipeline.
    // see const pipeline = device.createRenderPipeline({ 'buffers' object.
    passEncoder.setVertexBuffer(0, vertexBuffer);
    // how many vertices to draw.
    passEncoder.draw(3);
    // we're done with the render (command).
    // seems to not be a recognized method even if it's in the docs?
    // https://developer.mozilla.org/en-US/docs/Web/API/GPURenderPassEncoder/end
    passEncoder.end();

    // at this point the rendering is setup but we haven't drawn, we've just made a list of
    // commands and specified the data to use.
    // we're done recording commands.
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
    const vertexBuffer = setupData(device);
    const pipeline = setupPipeline(device);
    const commands = setupCommands(device, context, pipeline, vertexBuffer);

    // finally draws.
    device.queue.submit([commands]);

    // TODO
    // a) i wonder what other methods are on queue other than writeBuffer for the vertex
    // buffer and submit for the commands.
    // b) no doubt the buffer must be written before commands can if the queue is processed
    // linearly in order of what's submitted to it, however i wonder if that is a hard
    // requirement?
}

main();